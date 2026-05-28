import { homedir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Fiber, Queue, Ref, Schema } from "effect"
import {
  ConversationId,
  ConversationStore,
  FileSystem,
  Llm,
  LlmCache,
  LlmInfo,
  SettingsStore,
  Shell,
  coderAgentConfig,
  runAgent,
  type InstructionFile,
  type ScopedAgentConfig,
  type Skill,
} from "@agent/core"

import type { AgentEvent } from "../events.js"
import { makeEventHooks } from "../events.js"
import { bashConfirmHook } from "../safetyHooks.js"

import {
  ansi,
  enterTui,
  exitTui,
  getTermSize,
  setupRawMode,
  showCursor,
  SPINNER_FRAMES,
} from "../tui/terminal.js"
import { KeyParser, type Key } from "../tui/keys.js"
import { emptyInput, inputText, type InputState, applyKey } from "../tui/input.js"
import { Scrollback } from "../tui/scrollback.js"
import type { StatusState } from "../tui/statusBar.js"
import {
  computePalette,
  hiddenPalette,
  movePalette,
  selectedCommand,
  type PaletteState,
} from "../tui/slashPalette.js"
import { hiddenModal, type ModalState } from "../tui/modal.js"
import { type SidePaneState } from "../tui/sidePane.js"
import {
  emptyTree,
  onAgentEnd as treeAgentEnd,
  onSkillLoad as treeSkillLoad,
  onSubAgentEnd as treeSubAgentEnd,
  onSubAgentStart as treeSubAgentStart,
  onToolEnd as treeToolEnd,
  onToolStart as treeToolStart,
  onTurnStart as treeTurnStart,
} from "../tui/executionTree.js"
import { describeToolCall, describeToolResult } from "../tui/toolDescribe.js"
import { fileLoggerLayer } from "../tui/logger.js"
import { FrameRenderer, type AppState } from "../tui/render.js"
import { applyViKey, initialVi, type ViState } from "../tui/viMode.js"

interface MutableAppState {
  status: StatusState
  scrollback: Scrollback
  input: InputState
  palette: PaletteState
  modal: ModalState
  modalAnswer?: Deferred.Deferred<boolean, never>
  conversationId: ConversationId
  sidePane: SidePaneState
  vi: ViState
  /** A turn is in flight. Input stays live; submits queue. */
  busy: boolean
  /** The forked agent run, so Esc can interrupt it. */
  runningFiber?: Fiber.RuntimeFiber<void, never> | undefined
  /** FIFO of messages submitted while busy; drained on turn completion. */
  queue: string[]
  /** ms timestamp the current turn started, for the elapsed counter. */
  turnStartedAt: number
  /** Animation frame index for the busy spinner. */
  spinnerFrame: number
  /** 1-based index of the turn currently running (for the status note). */
  currentTurn: number
  /** ms timestamp of the last Ctrl-C, for 2×-to-quit. */
  ctrlCArmedAt?: number
}

/** Build the status-bar note: spinner + elapsed + turn + queued, or none. */
const computeNote = (s: MutableAppState): string | undefined => {
  if (!s.busy) return undefined
  const frame = SPINNER_FRAMES[s.spinnerFrame % SPINNER_FRAMES.length]
  const elapsed = Math.max(0, Math.round((Date.now() - s.turnStartedAt) / 1000))
  let note = `${frame} ${elapsed}s`
  if (s.currentTurn > 0) note += ` · turn ${s.currentTurn}`
  if (s.queue.length > 0) note += ` · queued:${s.queue.length}`
  return note
}

const HELP_LINES = [
  "Keybindings:",
  "  Enter         submit (queues if a turn is running)",
  "  Esc           interrupt a running turn (or vi normal mode)",
  "  Ctrl-J        newline within input",
  "  Ctrl-C        quit (press twice)",
  "  Ctrl-D        quit (when input is empty)",
  "  Ctrl-L        clear scrollback",
  "  PgUp / PgDn   scroll the conversation",
  "  ↑/↓           navigate input lines or palette",
  "Slash commands:",
  "  /exit /quit   quit",
  "  /clear        clear scrollback",
  "  /help         show this help",
  "  /cwd          print workspace path",
  "  /reset        start a new conversation",
  "  /settings     show configuration settings",
  "  /set <k> <v>  update setting (e.g. /set maxSteps 15)",
]

const snapshot = (s: MutableAppState): AppState => ({
  status: { ...s.status, note: computeNote(s) },
  scrollback: s.scrollback,
  input: s.input,
  palette: s.palette,
  modal: s.modal,
  sidePane: s.sidePane,
  spinnerFrame: s.spinnerFrame,
})

const decodeConversationId = Schema.decodeUnknown(ConversationId)

const newConversationId = (): ConversationId =>
  Effect.runSync(decodeConversationId(crypto.randomUUID()).pipe(Effect.orDie))

export interface TuiModeInput {
  readonly cwd: string
  readonly skills: ReadonlyArray<Skill>
  readonly scopedAgents: ReadonlyArray<ScopedAgentConfig>
  readonly instructionFiles: ReadonlyArray<InstructionFile>
  readonly resumeConversationId?: string
}

const logFilePath = (): string => join(homedir(), ".agent", "agent.log")

const seedSidePane = (
  instructions: ReadonlyArray<InstructionFile>,
): SidePaneState => ({
  tree: emptyTree,
  skillsLoaded: [],
  instructions: instructions.map((f) => ({
    path: f.path,
    scope: f.path,
  })),
})

const runTuiModeCore = (
  input: TuiModeInput,
): Effect.Effect<
  void,
  never,
  FileSystem | Shell | Llm | LlmCache | LlmInfo | ConversationStore | SettingsStore
> =>
  Effect.gen(function* () {
    const info = yield* LlmInfo
    const meta = yield* info.metadata

    const initialCid =
      input.resumeConversationId !== undefined
        ? yield* decodeConversationId(input.resumeConversationId).pipe(
            Effect.orDie,
          )
        : newConversationId()

    const stateRef = yield* Ref.make<MutableAppState>({
      status: {
        modelId: meta.modelId,
        contextWindow: meta.contextWindow,
        inputTokens: 0,
        cacheReadTokens: 0,
        cwd: input.cwd,
      },
      scrollback: new Scrollback(),
      input: emptyInput,
      palette: hiddenPalette,
      modal: hiddenModal,
      conversationId: initialCid,
      sidePane: seedSidePane(input.instructionFiles),
      vi: initialVi,
      busy: false,
      queue: [],
      turnStartedAt: 0,
      spinnerFrame: 0,
      currentTurn: 0,
    })

    const renderer = new FrameRenderer()

    // Coalesced render scheduler: state mutations mark the frame dirty;
    // an actual paint happens at most once per MIN_INTERVAL_MS (~60fps),
    // so a burst of events collapses into a single frame. Idle = no
    // timer = zero writes = no flashing. (Modeled after pi's scheduler.)
    const MIN_INTERVAL_MS = 16
    let dirty = false
    let renderTimer: ReturnType<typeof setTimeout> | undefined
    let lastRenderAt = 0
    const doRender = (): void => {
      const s = Effect.runSync(Ref.get(stateRef))
      renderer.draw(snapshot(s))
    }
    const scheduleRender = (): void => {
      if (renderTimer !== undefined) return
      const elapsed = performance.now() - lastRenderAt
      const delay = Math.max(0, MIN_INTERVAL_MS - elapsed)
      renderTimer = setTimeout(() => {
        renderTimer = undefined
        if (!dirty) return
        dirty = false
        lastRenderAt = performance.now()
        doRender()
      }, delay)
    }
    const requestRender = Effect.sync(() => {
      dirty = true
      scheduleRender()
    })

    // Spinner animation — only runs while a turn is busy. Self-stops on
    // the first tick after the turn ends, so idle = no timer = no paints.
    let spinnerTimer: ReturnType<typeof setInterval> | undefined
    const stopSpinner = (): void => {
      if (spinnerTimer !== undefined) {
        clearInterval(spinnerTimer)
        spinnerTimer = undefined
      }
    }
    const startSpinner = (): void => {
      if (spinnerTimer !== undefined) return
      spinnerTimer = setInterval(() => {
        const s = Effect.runSync(Ref.get(stateRef))
        if (!s.busy) {
          stopSpinner()
          return
        }
        Effect.runSync(
          Ref.update(stateRef, (st) => {
            st.spinnerFrame = st.spinnerFrame + 1
            return st
          }),
        )
        dirty = true
        scheduleRender()
      }, 80)
    }

    yield* Ref.update(stateRef, (s) => {
      s.scrollback.push({
        kind: "info",
        text: `agent · ${meta.modelId} · cwd: ${input.cwd}`,
      })
      s.scrollback.push({
        kind: "info",
        text: `logs: tail -f ${logFilePath()}`,
      })
      s.scrollback.push({
        kind: "info",
        text: "type / for commands · Enter submits · Esc interrupts · PgUp/PgDn scroll · Ctrl-C ×2 quits",
      })
      return s
    })

    enterTui()
    const restoreRaw = setupRawMode()

    const origConsoleLog = console.log
    const origConsoleError = console.error
    const noop = (() => {}) as typeof console.log
    console.log = noop
    console.error = noop

    const cleanup = (): void => {
      console.log = origConsoleLog
      console.error = origConsoleError
      restoreRaw()
      exitTui()
      process.stdout.write(showCursor + ansi.reset + "\n")
    }

    const onResize = (): void => {
      renderer.reset()
      dirty = true
      scheduleRender()
    }
    process.stdout.on("resize", onResize)

    yield* requestRender

    // ---- Event consumer: agent events → scrollback (clean chat) + tree ----
    const eventQueue = yield* Queue.unbounded<AgentEvent>()
    // Match tool_call_end → its tree node and (top-level only) scrollback pill.
    const toolTreeId = new Map<string, number>()
    const toolScrollId = new Map<string, string>()
    let subAgentDepth = 0
    let toolSeq = 0
    const isDelegate = (name: string): boolean => name.startsWith("delegate_to_")
    const consumer = yield* Effect.forkDaemon(
      Effect.gen(function* () {
        while (true) {
          const event = yield* Queue.take(eventQueue)
          yield* Ref.update(stateRef, (s) => {
            const now = Date.now()
            switch (event.type) {
              case "turn_start": {
                s.currentTurn = event.turnIndex + 1
                s.sidePane = {
                  ...s.sidePane,
                  tree: treeTurnStart(s.sidePane.tree, event.turnIndex, now),
                }
                break
              }
              case "tool_call_start": {
                // Delegations are represented by the sub-agent container,
                // not a tool node — skip them here.
                if (isDelegate(event.toolName)) break
                const label = describeToolCall(event.toolName, event.args)
                const { tree, id } = treeToolStart(s.sidePane.tree, label, now)
                s.sidePane = { ...s.sidePane, tree }
                toolTreeId.set(event.toolName, id)
                // Top-level tools also get a compact chat line; sub-agent
                // inner tools live only in the tree.
                if (subAgentDepth === 0) {
                  toolSeq++
                  const sid = `t${toolSeq}`
                  toolScrollId.set(event.toolName, sid)
                  s.scrollback.push({
                    kind: "tool",
                    id: sid,
                    toolName: label,
                    arg: "",
                    state: "running",
                  })
                }
                break
              }
              case "tool_call_end": {
                if (isDelegate(event.toolName)) break
                const detail = describeToolResult(
                  event.toolName,
                  event.ok,
                  event.result,
                )
                const nodeId = toolTreeId.get(event.toolName)
                if (nodeId !== undefined) {
                  s.sidePane = {
                    ...s.sidePane,
                    tree: treeToolEnd(
                      s.sidePane.tree,
                      nodeId,
                      event.ok,
                      detail,
                      now,
                    ),
                  }
                  toolTreeId.delete(event.toolName)
                }
                const sid = toolScrollId.get(event.toolName)
                if (sid !== undefined) {
                  s.scrollback.updateTool(sid, {
                    state: event.ok ? "ok" : "error",
                    ...(detail !== undefined ? { arg: detail } : {}),
                  })
                  toolScrollId.delete(event.toolName)
                }
                break
              }
              case "subagent_start": {
                subAgentDepth++
                s.sidePane = {
                  ...s.sidePane,
                  tree: treeSubAgentStart(
                    s.sidePane.tree,
                    `delegate → ${event.name}`,
                    now,
                  ),
                }
                break
              }
              case "subagent_end": {
                subAgentDepth = Math.max(0, subAgentDepth - 1)
                const filesDetail =
                  event.filesChanged.length > 0
                    ? `${event.filesChanged.length} file${
                        event.filesChanged.length === 1 ? "" : "s"
                      }`
                    : undefined
                s.sidePane = {
                  ...s.sidePane,
                  tree: treeSubAgentEnd(
                    s.sidePane.tree,
                    event.ok,
                    filesDetail,
                    now,
                  ),
                }
                const tag = event.ok ? "⤴" : "✗"
                s.scrollback.push({
                  kind: "info",
                  text: `${tag} delegate → ${event.name}${
                    filesDetail !== undefined ? ` (${filesDetail})` : ""
                  }`,
                })
                break
              }
              case "skill_load": {
                if (!s.sidePane.skillsLoaded.includes(event.name)) {
                  s.sidePane = {
                    ...s.sidePane,
                    skillsLoaded: [...s.sidePane.skillsLoaded, event.name],
                  }
                }
                break
              }
              case "assistant_message": {
                if (event.text.trim().length > 0) {
                  s.scrollback.push({ kind: "assistant", text: event.text })
                }
                if (event.usage !== undefined) {
                  s.status = {
                    ...s.status,
                    inputTokens: event.usage.inputTokens,
                    cacheReadTokens: event.usage.cacheReadTokens,
                  }
                }
                break
              }
              case "agent_end": {
                s.sidePane = {
                  ...s.sidePane,
                  tree: treeAgentEnd(s.sidePane.tree, now),
                }
                if (event.finalText.trim().length === 0) {
                  s.scrollback.push({
                    kind: "info",
                    text: `(agent stopped without a final answer — see ~/.agent/agent.log)`,
                  })
                }
                break
              }
              case "error":
                s.scrollback.push({ kind: "error", text: event.message })
                break
              default:
                break
            }
            return s
          })
          yield* requestRender
        }
      }),
    )

    // ---- Bash confirm hook ----
    const promptForBash = (cmd: string, cwd: string) =>
      Effect.gen(function* () {
        const def = yield* Deferred.make<boolean, never>()
        yield* Ref.update(stateRef, (s) => {
          s.modal = {
            visible: true,
            title: "Run shell command?",
            body: `${cmd}\n\ncwd: ${cwd}`,
            yes: "y",
            no: "n",
          }
          s.modalAnswer = def
          return s
        })
        yield* requestRender
        const result = yield* Deferred.await(def)
        yield* Ref.update(stateRef, (s) => {
          s.modal = hiddenModal
          delete s.modalAnswer
          return s
        })
        yield* requestRender
        return result
      })

    type R_Base = FileSystem | Shell | ConversationStore | Llm | LlmCache | SettingsStore
    const safetyHook = bashConfirmHook<R_Base>(promptForBash, input.cwd)
    const baseHooks = makeEventHooks<R_Base>(eventQueue, safetyHook)

    const submit = (
      text: string,
    ): Effect.Effect<void, never, R_Base> =>
      Effect.gen(function* () {
        const cur = yield* Ref.get(stateRef)

        // Busy → queue it for after the current turn.
        if (cur.busy) {
          yield* Ref.update(stateRef, (s) => {
            s.queue = [...s.queue, text]
            s.scrollback.push({ kind: "info", text: `queued: ${text}` })
            return s
          })
          yield* requestRender
          return
        }

        cur.scrollback.push({ kind: "user", text })
        cur.scrollback.stickToBottom()
        yield* Ref.update(stateRef, (s) => {
          s.input = emptyInput
          s.busy = true
          s.turnStartedAt = Date.now()
          s.spinnerFrame = 0
          s.currentTurn = 0
          return s
        })
        startSpinner()
        yield* requestRender

        const cid = cur.conversationId

        // Drain one queued message (if any) and reset busy state. Runs on
        // success, failure, AND interruption (Esc) via `ensuring`, so the
        // tree never gets stuck mid-run.
        const finishTurn = Effect.gen(function* () {
          subAgentDepth = 0
          toolTreeId.clear()
          toolScrollId.clear()
          const next = yield* Ref.modify(stateRef, (s) => {
            s.busy = false
            s.runningFiber = undefined
            s.sidePane = {
              ...s.sidePane,
              tree: treeAgentEnd(s.sidePane.tree, Date.now()),
            }
            const head = s.queue[0]
            s.queue = s.queue.slice(1)
            return [head, s] as const
          })
          yield* requestRender
          if (next !== undefined) yield* submit(next)
        })

        const runEffect = runAgent(
          coderAgentConfig(
            input.cwd,
            input.skills,
            input.scopedAgents,
            input.instructionFiles,
            undefined,
            baseHooks,
          ),
          cid,
          text,
          baseHooks,
        ).pipe(
          Effect.catchAll((err) => {
            const msg =
              typeof err === "object" && err !== null && "message" in err
                ? String((err as { message: unknown }).message)
                : String(err)
            return Queue.offer(eventQueue, { type: "error", message: msg })
          }),
          Effect.asVoid,
          Effect.ensuring(finishTurn),
        )

        const fiber = yield* Effect.forkDaemon(runEffect)
        yield* Ref.update(stateRef, (s) => {
          s.runningFiber = fiber
          return s
        })
      })

    const handleSlash = (cmd: string) =>
      Effect.gen(function* () {
        const parts = cmd.trim().split(/\s+/)
        const baseCmd = parts[0]
        switch (baseCmd) {
          case "/exit":
          case "/quit":
            return "exit" as const
          case "/clear":
            yield* Ref.update(stateRef, (s) => {
              s.scrollback.clear()
              s.sidePane = { ...s.sidePane, tree: emptyTree }
              return s
            })
            yield* requestRender
            return "stay" as const
          case "/help":
            yield* Ref.update(stateRef, (s) => {
              for (const line of HELP_LINES) {
                s.scrollback.push({ kind: "info", text: line })
              }
              return s
            })
            yield* requestRender
            return "stay" as const
          case "/cwd":
            yield* Ref.update(stateRef, (s) => {
              s.scrollback.push({ kind: "info", text: `cwd: ${input.cwd}` })
              return s
            })
            yield* requestRender
            return "stay" as const
          case "/reset":
            yield* Ref.update(stateRef, (s) => {
              s.conversationId = newConversationId()
              s.sidePane = { ...s.sidePane, tree: emptyTree }
              s.scrollback.push({
                kind: "info",
                text: `new conversation: ${s.conversationId.slice(0, 8)}`,
              })
              return s
            })
            yield* requestRender
            return "stay" as const
          case "/settings": {
            const settingsStore = yield* SettingsStore
            const current = yield* settingsStore.get()
            yield* Ref.update(stateRef, (s) => {
              s.scrollback.push({ kind: "info", text: "--- Configuration Settings ---" })
              s.scrollback.push({ kind: "info", text: `allowBash: ${current.allowBash}` })
              s.scrollback.push({ kind: "info", text: `maxSteps: ${current.maxSteps}` })
              return s
            })
            yield* requestRender
            return "stay" as const
          }
          case "/set": {
            const k = parts[1]
            const v = parts.slice(2).join(" ")
            if (!k || !v) {
              yield* Ref.update(stateRef, (s) => {
                s.scrollback.push({
                  kind: "error",
                  text: "Usage: /set <key> <value> (e.g. /set maxSteps 15)",
                })
                return s
              })
              yield* requestRender
              return "stay" as const
            }

            const settingsStore = yield* SettingsStore
            const current = yield* settingsStore.get()

            const validKeys: ReadonlyArray<keyof typeof current> = ["allowBash", "maxSteps", "editorMode"]
            if (!validKeys.includes(k as any)) {
              yield* Ref.update(stateRef, (s) => {
                s.scrollback.push({ kind: "error", text: `Unknown setting: ${k}. Valid settings: ${validKeys.join(", ")}` })
                return s
              })
              yield* requestRender
              return "stay" as const
            }

            const key = k as keyof typeof current
            let typedVal: typeof current[typeof key]

            if (key === "maxSteps") {
              const num = Number(v)
              if (Number.isNaN(num) || !Number.isFinite(num)) {
                yield* Ref.update(stateRef, (s) => {
                  s.scrollback.push({ kind: "error", text: `Setting '${k}' must be a finite number` })
                  return s
                })
                yield* requestRender
                return "stay" as const
              }
              typedVal = num
            } else if (key === "allowBash") {
              if (v === "true") {
                typedVal = true
              } else if (v === "false") {
                typedVal = false
              } else {
                yield* Ref.update(stateRef, (s) => {
                  s.scrollback.push({ kind: "error", text: `Setting '${k}' must be 'true' or 'false'` })
                  return s
                })
                yield* requestRender
                return "stay" as const
              }
            } else if (key === "editorMode") {
              if (v !== "insert" && v !== "vi") {
                yield* Ref.update(stateRef, (s) => {
                  s.scrollback.push({ kind: "error", text: `Setting '${k}' must be 'insert' or 'vi'` })
                  return s
                })
                yield* requestRender
                return "stay" as const
              }
              typedVal = v
            } else {
              typedVal = v as any
            }

            yield* settingsStore.update((curr) => ({
              ...curr,
              [key]: typedVal,
            }))

            yield* Ref.update(stateRef, (s) => {
              s.scrollback.push({ kind: "info", text: `Updated setting '${k}' to: ${typedVal}` })
              return s
            })
            yield* requestRender
            return "stay" as const
          }
          default: {
            yield* Ref.update(stateRef, (s) => {
              s.scrollback.push({
                kind: "error",
                text: `unknown command: ${cmd}`,
              })
              return s
            })
            yield* requestRender
            return "stay" as const
          }
        }
      })

    // ---- Input loop ----
    const exitDeferred = yield* Deferred.make<void, never>()
    const parser = new KeyParser()

    const handleKey = (key: Key): Effect.Effect<"stay" | "exit", never, FileSystem | Shell | ConversationStore | Llm | LlmCache | SettingsStore> =>
      Effect.gen(function* () {
        const s = yield* Ref.get(stateRef)

        if (s.modal.visible && s.modalAnswer !== undefined) {
          if (key.type === "char") {
            if (key.char === s.modal.yes) {
              yield* Deferred.succeed(s.modalAnswer, true)
              return "stay" as const
            }
            if (key.char === s.modal.no) {
              yield* Deferred.succeed(s.modalAnswer, false)
              return "stay" as const
            }
          }
          if (key.type === "escape") {
            yield* Deferred.succeed(s.modalAnswer, false)
            return "stay" as const
          }
          if (key.type === "ctrl" && key.char === "c") {
            yield* Deferred.succeed(s.modalAnswer, false)
            return "stay" as const
          }
          return "stay" as const
        }

        // Ctrl-C → quit, but require a confirming second press within 2s.
        if (key.type === "ctrl" && key.char === "c") {
          const now = Date.now()
          if (s.ctrlCArmedAt !== undefined && now - s.ctrlCArmedAt < 2000) {
            return "exit" as const
          }
          yield* Ref.update(stateRef, (st) => {
            st.ctrlCArmedAt = now
            st.scrollback.push({
              kind: "info",
              text: "press Ctrl-C again to quit",
            })
            return st
          })
          yield* requestRender
          return "stay" as const
        }

        // Esc while a turn is running → interrupt it (takes priority over
        // vi normal-mode entry, which only applies when idle).
        if (key.type === "escape" && s.busy && s.runningFiber !== undefined) {
          yield* Fiber.interruptFork(s.runningFiber)
          yield* Ref.update(stateRef, (st) => {
            st.scrollback.push({ kind: "info", text: "⨯ interrupted" })
            return st
          })
          yield* requestRender
          return "stay" as const
        }

        // PageUp/PageDown: scroll the scrollback regardless of palette state.
        if (key.type === "pageUp") {
          yield* Ref.update(stateRef, (st) => {
            st.scrollback.scrollBy(5)
            return st
          })
          yield* requestRender
          return "stay" as const
        }
        if (key.type === "pageDown") {
          yield* Ref.update(stateRef, (st) => {
            st.scrollback.scrollBy(-5)
            return st
          })
          yield* requestRender
          return "stay" as const
        }

        if (s.palette.visible) {
          if (key.type === "arrow" && key.dir === "up") {
            yield* Ref.update(stateRef, (st) => {
              st.palette = movePalette(st.palette, "up")
              return st
            })
            yield* requestRender
            return "stay" as const
          }
          if (key.type === "arrow" && key.dir === "down") {
            yield* Ref.update(stateRef, (st) => {
              st.palette = movePalette(st.palette, "down")
              return st
            })
            yield* requestRender
            return "stay" as const
          }
          if (key.type === "tab") {
            const cmd = selectedCommand(s.palette)
            if (cmd !== undefined) {
              yield* Ref.update(stateRef, (st) => {
                st.input = {
                  lines: [cmd.name],
                  row: 0,
                  col: cmd.name.length,
                  locked: false,
                }
                st.palette = hiddenPalette
                return st
              })
              yield* requestRender
            }
            return "stay" as const
          }
          if (key.type === "enter") {
            const cmd = selectedCommand(s.palette)
            if (cmd !== undefined) {
              yield* Ref.update(stateRef, (st) => {
                st.input = emptyInput
                st.palette = hiddenPalette
                return st
              })
              const outcome = yield* handleSlash(cmd.name)
              return outcome === "exit" ? ("exit" as const) : ("stay" as const)
            }
            return "stay" as const
          }
        }

        const settingsStore = yield* SettingsStore
        const settings = yield* settingsStore.get()
        const cols = getTermSize().cols

        let nextInput: InputState
        let nextVi: ViState = s.vi
        let action = undefined as
          | undefined
          | { readonly type: "submit"; readonly text: string }
          | { readonly type: "exit" }
          | { readonly type: "clearScrollback" }

        if (settings.editorMode === "vi") {
          const r = applyViKey(s.vi, s.input, key, cols)
          nextInput = r.input
          nextVi = r.vi
          action = r.action
        } else {
          if (s.vi.mode !== "insert") nextVi = { mode: "insert" }
          const r = applyKey(s.input, key, cols)
          nextInput = r.state
          action = r.action
        }

        const newPalette = computePalette(inputText(nextInput))
        yield* Ref.update(stateRef, (st) => {
          st.input = nextInput
          st.palette = newPalette
          st.vi = nextVi
          if (settings.editorMode === "vi") {
            st.status = {
              ...st.status,
              mode: nextVi.mode === "normal" ? "NOR" : "INS",
            }
          } else {
            const ns = { ...st.status }
            delete (ns as { mode?: unknown }).mode
            st.status = ns
          }
          return st
        })

        if (action !== undefined) {
          switch (action.type) {
            case "exit":
              return "exit" as const
            case "clearScrollback":
              yield* Ref.update(stateRef, (st) => {
                st.scrollback.clear()
                return st
              })
              yield* requestRender
              return "stay" as const
            case "submit": {
              if (action.text.startsWith("/")) {
                const outcome = yield* handleSlash(action.text.trim())
                if (outcome === "exit") return "exit" as const
                return "stay" as const
              }
              yield* submit(action.text)
              return "stay" as const
            }
          }
        }
        yield* requestRender
        return "stay" as const
      })

    const runtime = yield* Effect.runtime<FileSystem | Shell | ConversationStore | Llm | LlmCache | SettingsStore>()

    const dispatchKeys = (keys: ReadonlyArray<Key>): void => {
      for (const k of keys) {
        Effect.runPromise(Effect.provide(handleKey(k), runtime))
          .then((outcome) => {
            if (outcome === "exit") {
              void Effect.runPromise(Deferred.succeed(exitDeferred, undefined))
            }
          })
          .catch(() => {})
      }
    }

    let escFlushTimer: ReturnType<typeof setTimeout> | undefined
    const onData = (chunk: Buffer): void => {
      // New bytes arrived — any held lone ESC is now part of a sequence
      // (or precedes a real key), so cancel the pending flush and let
      // `feed` resolve it.
      if (escFlushTimer !== undefined) {
        clearTimeout(escFlushTimer)
        escFlushTimer = undefined
      }
      dispatchKeys(parser.feed(chunk))
      // A lone ESC is held back by the parser; flush it as a real Escape
      // after a short grace window if nothing follows.
      if (parser.hasPendingEscape()) {
        escFlushTimer = setTimeout(() => {
          escFlushTimer = undefined
          dispatchKeys(parser.flushEscape())
        }, 30)
      }
    }
    process.stdin.on("data", onData)

    yield* Deferred.await(exitDeferred)

    process.stdin.off("data", onData)
    process.stdout.off("resize", onResize)
    if (renderTimer !== undefined) clearTimeout(renderTimer)
    if (escFlushTimer !== undefined) clearTimeout(escFlushTimer)
    stopSpinner()
    yield* Fiber.interrupt(consumer)
    cleanup()
  })

export const runTuiMode = (
  input: TuiModeInput,
): Effect.Effect<
  void,
  never,
  FileSystem | Shell | Llm | LlmCache | LlmInfo | ConversationStore | SettingsStore
> =>
  runTuiModeCore(input).pipe(
    Effect.provide(fileLoggerLayer(logFilePath())),
  )
