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
} from "../tui/terminal.js"
import { KeyParser, type Key } from "../tui/keys.js"
import { emptyInput, inputText, type InputState, applyKey } from "../tui/input.js"
import {
  Scrollback,
  type ScrollbackBlock,
  type ToolPillState,
} from "../tui/scrollback.js"
import type { StatusState } from "../tui/statusBar.js"
import {
  computePalette,
  hiddenPalette,
  movePalette,
  selectedCommand,
  type PaletteState,
} from "../tui/slashPalette.js"
import { hiddenModal, type ModalState } from "../tui/modal.js"
import {
  type AgentStackFrame,
  type SidePaneState,
} from "../tui/sidePane.js"
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
}

const HELP_LINES = [
  "Keybindings:",
  "  Enter         submit",
  "  Ctrl-J        newline within input",
  "  Ctrl-C        exit",
  "  Ctrl-D        exit (when input is empty)",
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
  status: s.status,
  scrollback: s.scrollback,
  input: s.input,
  palette: s.palette,
  modal: s.modal,
  sidePane: s.sidePane,
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

const renderArgsForPill = (args: unknown): string => {
  if (typeof args !== "object" || args === null) return ""
  const obj = args as Record<string, unknown>
  if (typeof obj.path === "string") return obj.path
  if (typeof obj.command === "string") return obj.command
  if (typeof obj.pattern === "string") return obj.pattern
  if (typeof obj.task === "string") return obj.task
  try {
    return JSON.stringify(obj).slice(0, 80)
  } catch {
    return ""
  }
}

const logFilePath = (): string => join(homedir(), ".agent", "agent.log")

const seedSidePane = (
  instructions: ReadonlyArray<InstructionFile>,
): SidePaneState => ({
  stack: [{ name: "coder", status: "idle" }],
  skillsLoaded: [],
  instructions: instructions.map((f) => ({
    path: f.path,
    scope: f.path,
  })),
})

const updateTopFrame = (
  stack: ReadonlyArray<AgentStackFrame>,
  patch: Partial<AgentStackFrame>,
): ReadonlyArray<AgentStackFrame> => {
  if (stack.length === 0) return stack
  const next = stack.slice()
  const top = next[next.length - 1]!
  next[next.length - 1] = { ...top, ...patch }
  return next
}

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
    })

    const renderer = new FrameRenderer()

    const requestRender = Effect.gen(function* () {
      const s = yield* Ref.get(stateRef)
      renderer.draw(snapshot(s))
    })

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
        text: "type / for commands · Enter to submit · PgUp/PgDn to scroll · Ctrl-C to exit",
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
      void Effect.runPromise(requestRender as Effect.Effect<void, never, never>)
    }
    process.stdout.on("resize", onResize)

    const tickTimer = setInterval(() => {
      void Effect.runPromise(
        requestRender as Effect.Effect<void, never, never>,
      ).catch(() => {})
    }, 250)

    yield* requestRender

    // ---- Event consumer: agent events → scrollback / side pane ----
    const eventQueue = yield* Queue.unbounded<AgentEvent>()
    const currentToolByName = new Map<string, string>()
    let toolSeq = 0
    const consumer = yield* Effect.forkDaemon(
      Effect.gen(function* () {
        while (true) {
          const event = yield* Queue.take(eventQueue)
          yield* Ref.update(stateRef, (s) => {
            switch (event.type) {
              case "turn_start": {
                s.status = {
                  ...s.status,
                  note: `thinking (turn ${event.turnIndex + 1})`,
                }
                s.sidePane = {
                  ...s.sidePane,
                  stack: updateTopFrame(s.sidePane.stack, {
                    status: "running",
                  }),
                }
                break
              }
              case "tool_call_start": {
                const inSubAgent = s.sidePane.stack.length > 1
                if (inSubAgent) {
                  // Route to side pane only; no scrollback pill.
                  s.sidePane = {
                    ...s.sidePane,
                    stack: updateTopFrame(s.sidePane.stack, {
                      currentTool: event.toolName,
                    }),
                  }
                } else {
                  toolSeq++
                  const id = `t${toolSeq}`
                  currentToolByName.set(event.toolName, id)
                  s.scrollback.push({
                    kind: "tool",
                    id,
                    toolName: event.toolName,
                    arg: renderArgsForPill(event.args),
                    state: "running",
                  })
                  s.sidePane = {
                    ...s.sidePane,
                    stack: updateTopFrame(s.sidePane.stack, {
                      currentTool: event.toolName,
                    }),
                  }
                  s.status = {
                    ...s.status,
                    note: `running ${event.toolName}`,
                  }
                }
                break
              }
              case "tool_call_end": {
                const inSubAgent = s.sidePane.stack.length > 1
                if (!inSubAgent) {
                  const id = currentToolByName.get(event.toolName)
                  if (id !== undefined) {
                    const nextState: ToolPillState = event.ok ? "ok" : "error"
                    let detail: string | undefined
                    if (!event.ok && typeof event.result === "object") {
                      const r = event.result as Record<string, unknown>
                      if (typeof r.message === "string") detail = r.message
                      else if (typeof r.reason === "string") detail = r.reason
                    }
                    s.scrollback.updateTool(id, {
                      state: nextState,
                      ...(detail !== undefined ? { detail } : {}),
                    })
                    currentToolByName.delete(event.toolName)
                  }
                  s.status = { ...s.status, note: "thinking" }
                }
                s.sidePane = {
                  ...s.sidePane,
                  stack: updateTopFrame(s.sidePane.stack, {
                    currentTool: undefined,
                  }),
                }
                break
              }
              case "subagent_start": {
                s.sidePane = {
                  ...s.sidePane,
                  stack: [
                    ...s.sidePane.stack,
                    { name: event.name, status: "running" },
                  ],
                }
                s.status = {
                  ...s.status,
                  note: `delegating → ${event.name}`,
                }
                break
              }
              case "subagent_end": {
                const stack = s.sidePane.stack.slice()
                stack.pop()
                s.sidePane = { ...s.sidePane, stack }
                const tag = event.ok ? "⤴" : "✗"
                const filesNote =
                  event.filesChanged.length > 0
                    ? ` (${event.filesChanged.length} file${
                        event.filesChanged.length === 1 ? "" : "s"
                      } changed)`
                    : ""
                s.scrollback.push({
                  kind: "info",
                  text: `${tag} ${event.name} finished${filesNote}`,
                })
                s.status = { ...s.status, note: "thinking" }
                break
              }
              case "skill_load": {
                const exists = s.sidePane.skillsLoaded.includes(event.name)
                if (!exists) {
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
                const status = { ...s.status }
                delete (status as { note?: string }).note
                s.status = status
                s.sidePane = {
                  ...s.sidePane,
                  stack: updateTopFrame(s.sidePane.stack, {
                    status: "idle",
                    currentTool: undefined,
                  }),
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

    const submit = (text: string) =>
      Effect.gen(function* () {
        const cur = yield* Ref.get(stateRef)
        cur.scrollback.push({ kind: "user", text })
        cur.scrollback.stickToBottom()
        yield* Ref.update(stateRef, (s) => {
          s.input = { ...emptyInput, locked: true }
          s.status = { ...s.status, note: "running" }
          return s
        })
        yield* requestRender

        const cid = cur.conversationId
        yield* runAgent(
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
        )
        yield* Effect.sleep("50 millis")
        yield* Ref.update(stateRef, (s) => {
          s.input = emptyInput
          const status = { ...s.status }
          delete (status as { note?: string }).note
          s.status = status
          return s
        })
        yield* requestRender
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

    const onData = (chunk: Buffer): void => {
      const keys = parser.feed(chunk)
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
    process.stdin.on("data", onData)

    yield* Deferred.await(exitDeferred)

    process.stdin.off("data", onData)
    process.stdout.off("resize", onResize)
    clearInterval(tickTimer)
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
