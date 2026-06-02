import { homedir } from "node:os"
import { join } from "node:path"
import { LanguageModel } from "@effect/ai"
import { Deferred, Effect, Fiber, Queue, Ref, Schema } from "effect"
import {
  AuthStore,
  ConversationId,
  ConversationStore,
  FileSystem,
  Http,
  LlmInfo,
  ModelRegistry,
  SettingsStore,
  Shell,
  WebSearch,
  buildScopeRuntime,
  coderAgentConfig,
  defaultModelForProvider,
  maskDbUrl,
  parseModel,
  runAgent,
  createHandoff,
  type AgentMessage,
  type AuthData,
  type Checkpoint,
  type InstructionFile,
  type ModelInfo,
  type Provider,
  type Scope,
  type Skill,
} from "@efferent/core"

import {
  ANTHROPIC_CALLBACK_PORT,
  anthropicAuthorizeUrl,
  exchangeAnthropicCode,
  generatePkce,
  parseAuthorizationInput,
} from "@efferent/adapters"

import type { AgentEvent } from "../events.js"
import { makeEventHooks } from "../events.js"
import { browserCommand, startCallbackServer } from "../login/oauthServer.js"

import {
  ansi,
  enterTui,
  exitTui,
  getTermSize,
  osc52,
  setupRawMode,
  showCursor,
  SPINNER_FRAMES,
} from "../tui/terminal.js"
import { KeyParser, type Key } from "../tui/keys.js"
import { emptyInput, inputText, type InputState, applyKey } from "../tui/input.js"
import { Scrollback } from "../tui/scrollback.js"
import { formatTokens, type StatusState } from "../tui/statusBar.js"
import {
  computePalette,
  hiddenPalette,
  movePalette,
  selectedCommand,
  type PaletteState,
} from "../tui/slashPalette.js"
import { hiddenModal, type ModalState } from "../tui/modal.js"
import { describeActiveDatabase, storageLabel } from "../tui/dbStatus.js"
import {
  openSelect,
  moveSelect,
  filterAppend,
  filterBackspace,
  selectedValue,
  type SelectState,
} from "../tui/selectBox.js"
import {
  loginAdvance,
  loginAppend,
  loginBack,
  loginBackspace,
  loginMove,
  loginSetOAuthStatus,
  openLogin,
  type LoginFlow,
  type ProviderStatus,
} from "../tui/loginFlow.js"
import {
  sideCurrentRow,
  sideCursorMove,
  sideCursorToEnd,
  sideCursorToTop,
  sideToggleNode,
  sideToggleSelect,
  stackCursorMove,
  stackCursorToEnd,
  stackCursorToTop,
  stackToggle,
  emptyStats,
  type FileChange,
  type SidePaneState,
} from "../tui/sidePane.js"
import {
  buildContextView,
  messagesForSelectedTurns,
  turnIdsOf,
} from "../tui/contextView.js"
import {
  emptyTree,
  onAgentEnd as treeAgentEnd,
  onSkillLoad as treeSkillLoad,
  onSubAgentEnd as treeSubAgentEnd,
  onSubAgentStart as treeSubAgentStart,
  onToolEnd as treeToolEnd,
  onToolStart as treeToolStart,
  onTurnDetail as treeTurnDetail,
  onTurnStart as treeTurnStart,
  type TreeNode,
} from "../tui/executionTree.js"
import {
  describeToolCall,
  describeToolResult,
  toolArtifacts,
} from "../tui/toolDescribe.js"
import { fileLoggerLayer } from "../tui/logger.js"
import { FrameRenderer, type AppState } from "../tui/render.js"
import { applyViKey, initialVi, type ViState } from "../tui/viMode.js"
import {
  type FocusPane,
  type UiMode,
} from "../tui/uiMode.js"
import {
  decideKey,
  type CursorMoveOp,
  type EntryMode,
  type ScrollOp,
} from "../tui/navKeys.js"

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
  /** Which pane has focus. Ctrl-h/j/k/l moves it. */
  focus: FocusPane
  /** Modal mode of the focused pane. INSERT only ever on the input pane. */
  mode: UiMode
  /** Pending first key of a two-key normal-mode motion (e.g. `g` of `gg`). */
  navPending?: "g" | undefined
  /** Command-line mode of the bottom input row: message / `:` command / `/` search. */
  entry: EntryMode
  /** The focused read-only pane is maximized (fills the middle region). */
  zoomed: boolean
  /** Pane that opened the current `/` search, restored on Esc-cancel. */
  preSearchFocus?: FocusPane | undefined
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
  /** Last `/model` listing, so `/model <#>` can resolve a numbered choice. */
  modelList?: ReadonlyArray<ModelInfo>
  /** Open `:model` select box (overlay); owns input while visible. */
  modelPicker?: SelectState<ModelInfo>
  /** Open `:login` flow (overlay); owns input while visible. */
  loginFlow?: LoginFlow
  /** In-flight OAuth login: PKCE verifier + callback-server stop + waiter fiber. */
  oauthSession?: {
    verifier: string
    stop: () => void
    fiber: Fiber.RuntimeFiber<void, never>
  }
  /** The active model's provider, to warn on a mid-conversation switch. */
  activeProvider: Provider
  /** Whether the current conversation already has at least one turn. */
  conversationHasTurns: boolean
  /** Fixed dim footer below the status bar (logs path + key hints). */
  footer: string
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
  "Panes (a real block cursor lives on the focused pane):",
  "  Ctrl-h/j/k/l     move focus: conversation · side · input",
  "  i / a            enter INSERT on the input pane; Esc → NORMAL",
  "  z                maximize / restore the focused pane (Esc exits)",
  "Conversation (NORMAL — nvim motions move the block cursor):",
  "  h/j/k/l          left / down / up / right",
  "  w / b / e        next / prev / end of word (W/B/E = WORD)",
  "  0 / ^ / $        line start / first non-blank / line end",
  "  gg / G           top / bottom (G re-follows new output)",
  "  Ctrl-D / Ctrl-U  half page;  PgUp / PgDn  page (~75%)",
  "  { / }            previous / next turn",
  "  v / V            charwise / linewise VISUAL; y yanks (clipboard)",
  "Folding (Neogit-style — turns are foldable 'commits'):",
  "  Tab / Enter      fold / unfold the turn or tool group under the cursor",
  "  Z                fold / unfold all turns",
  "  Ctrl-R           expand / collapse tool output & diffs",
  "Context viewer (side pane, NORMAL — `:context` to open):",
  "  j / k · gg / G   move the tree cursor (turns shown as foldable rows)",
  "  Space            select / deselect the turn under the cursor",
  "  b                build a NEW session from the selected turns + switch to it",
  "  Tab / h / l      fold / unfold a turn or handoff segment",
  "  Enter            jump to the turn / message in the conversation",
  "Search:",
  "  /                search; Enter lands on the match, n / N next / prev",
  "Turns:",
  "  Enter (INSERT)   newline (composing never submits)",
  "  Esc, then Enter  leave INSERT → NORMAL, then Enter sends the message",
  "  Ctrl-C           quit (press twice)",
  "Commands (type ':'):",
  "  :exit :quit      quit",
  "  :clear           clear scrollback",
  "  :help            show this help",
  "  :cwd             print workspace path",
  "  :reset           start a new conversation",
  "  :handoff         summarize & hand off — replace loaded history, keep originals",
  "  :context         toggle the context viewer (message tree + handoff)",
  "  :browse          list conversations in this workspace",
  "  :resume <#|id>   resume a conversation (run :browse first)",
  "  :settings        show configuration settings",
  "  :set <k> <v>     update setting (e.g. :set maxSteps 15)",
  "  :model           list models; :model <#|id> switches provider/model",
]

const snapshot = (s: MutableAppState): AppState => ({
  status: {
    ...s.status,
    note: computeNote(s),
  },
  scrollback: s.scrollback,
  input: s.input,
  palette: s.palette,
  modal: s.modal,
  modelPicker: s.modelPicker,
  loginFlow: s.loginFlow,
  sidePane: s.sidePane,
  spinnerFrame: s.spinnerFrame,
  focus: s.focus,
  mode: s.mode,
  entry: s.entry,
  zoomed: s.zoomed,
  footer: s.footer,
})

/**
 * Apply a scroll op by moving the conversation cursor (the viewport follows).
 * Used by both NORMAL nav and VISUAL extension — in VISUAL the same cursor
 * move grows the selection, so there's no separate handler.
 */
const applyScroll = (sb: Scrollback, op: ScrollOp): void => {
  switch (op) {
    case "lineUp":
      sb.moveCursor(-1)
      return
    case "lineDown":
      sb.moveCursor(1)
      return
    case "halfUp":
      sb.cursorHalfUp()
      return
    case "halfDown":
      sb.cursorHalfDown()
      return
    case "pageUp":
      sb.cursorPageUp()
      return
    case "pageDown":
      sb.cursorPageDown()
      return
    case "top":
      sb.cursorToTop()
      return
    case "bottom":
      sb.cursorToBottom()
      return
    case "msgUp":
      sb.cursorToMessage("up")
      return
    case "msgDown":
      sb.cursorToMessage("down")
      return
  }
}

/** Horizontal / word motions for the real block cursor (also extend VISUAL). */
const applyCursorMove = (sb: Scrollback, op: CursorMoveOp): void => {
  switch (op) {
    case "charLeft":
      sb.cursorCharLeft()
      return
    case "charRight":
      sb.cursorCharRight()
      return
    case "lineStart":
      sb.cursorLineStart()
      return
    case "lineEnd":
      sb.cursorLineEnd()
      return
    case "firstNonBlank":
      sb.cursorFirstNonBlank()
      return
    case "wordFwd":
      sb.cursorWord("fwd", false)
      return
    case "wordBack":
      sb.cursorWord("back", false)
      return
    case "wordEnd":
      sb.cursorWord("end", false)
      return
    case "wordFwdBig":
      sb.cursorWord("fwd", true)
      return
    case "wordBackBig":
      sb.cursorWord("back", true)
      return
    case "wordEndBig":
      sb.cursorWord("end", true)
      return
  }
}

const decodeConversationId = Schema.decodeUnknown(ConversationId)

const newConversationId = (): ConversationId =>
  Effect.runSync(decodeConversationId(crypto.randomUUID()).pipe(Effect.orDie))

/**
 * Replay a persisted conversation into the scrollback: each message → blocks,
 * with a `checkpoint` block pushed at every handoff fold so the user sees
 * "above = archived (not loaded), below = live." Used at startup (`--resume`)
 * and by the in-session `:resume` command. Browsing shows the FULL record;
 * execution still loads only the active window.
 */
const replayHistory = (
  sb: Scrollback,
  history: ReadonlyArray<AgentMessage>,
  checkpoints: ReadonlyArray<Checkpoint>,
): void => {
  let msgIdx = 0
  for (const msg of history) {
    // Tag every block with the message's position so the context viewer can
    // jump the conversation cursor to a chosen message (cursorToMessageIndex).
    if (msg.role === "user") {
      sb.push({ kind: "user", text: msg.content, msgIndex: msgIdx })
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        sb.push({ kind: "assistant", text: msg.content, msgIndex: msgIdx })
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "text") {
            if (part.text.trim().length > 0) {
              sb.push({ kind: "assistant", text: part.text, msgIndex: msgIdx })
            }
          } else if (part.type === "reasoning") {
            if (part.text.trim().length > 0) {
              sb.push({ kind: "reasoning", text: part.text, msgIndex: msgIdx })
            }
          } else if (part.type === "tool-call") {
            sb.push({
              kind: "tool",
              id: part.toolCallId,
              toolName: describeToolCall(part.toolName, part.input),
              state: "ok",
              msgIndex: msgIdx,
            })
          }
        }
      }
    } else if (msg.role === "tool") {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          const detail = describeToolResult(part.toolName, !part.isError, part.output)
          const artifacts = toolArtifacts(part.toolName, !part.isError, part.output)
          sb.updateTool(part.toolCallId, {
            state: part.isError ? "error" : "ok",
            ...(detail !== undefined ? { detail } : {}),
            ...(artifacts.diff !== undefined ? { diff: artifacts.diff } : {}),
            ...(artifacts.output !== undefined ? { output: artifacts.output } : {}),
          })
        }
      }
    }
    const cp = checkpoints.find((c) => c.messagePosition === msgIdx)
    if (cp !== undefined) sb.push({ kind: "checkpoint", text: cp.summary })
    msgIdx++
  }
}

export interface TuiModeInput {
  readonly cwd: string
  readonly skills: ReadonlyArray<Skill>
  readonly rootScope: Scope
  readonly instructionFiles: ReadonlyArray<InstructionFile>
  readonly resumeConversationId?: string
}

const logFilePath = (): string => join(homedir(), ".efferent", "efferent.log")

const seedSidePane = (
  instructions: ReadonlyArray<InstructionFile>,
  skills: ReadonlyArray<Skill>,
): SidePaneState => ({
  tree: emptyTree,
  // Seed with the skills discovered at startup (the `skill_load` event then
  // dedup-appends any read at runtime) so the section shows what's available.
  skillsLoaded: skills.map((s) => s.name),
  instructions: instructions.map((f) => ({
    path: f.path,
    scope: f.path,
  })),
  view: "stack",
  contextCursor: 0,
  contextCollapsed: new Set(),
  contextSelected: new Set(),
  contextHandoffSelected: new Set(),
  stats: emptyStats,
  filesChanged: [],
  stackCollapsed: new Set(["files", "skills", "instructions"]),
  stackCursor: 0,
})

const runTuiModeCore = (
  input: TuiModeInput,
): Effect.Effect<
  void,
  never,
  FileSystem | Http | Shell | LanguageModel.LanguageModel | LlmInfo | ModelRegistry | ConversationStore | SettingsStore | WebSearch | AuthStore
> =>
  Effect.gen(function* () {
    const info = yield* LlmInfo
    const meta = yield* info.metadata
    const registry = yield* ModelRegistry
    const initialSel = yield* registry.current

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
        storage: storageLabel(process.env.EFFERENT_DB_URL),
      },
      scrollback: new Scrollback(),
      input: emptyInput,
      palette: hiddenPalette,
      modal: hiddenModal,
      conversationId: initialCid,
      sidePane: {
        ...seedSidePane(input.instructionFiles, input.skills),
        stats: { ...emptyStats, startedAt: Date.now(), contextWindow: meta.contextWindow },
      },
      vi: initialVi,
      focus: "input",
      mode: "insert",
      entry: "message",
      zoomed: false,
      busy: false,
      queue: [],
      turnStartedAt: 0,
      spinnerFrame: 0,
      currentTurn: 0,
      activeProvider: initialSel.provider,
      conversationHasTurns: false,
      footer: `logs: tail -f ${logFilePath()}  ·  : commands · ↵ send · esc interrupt · ^C×2 quit`,
    })

    if (input.resumeConversationId !== undefined) {
      const store = yield* ConversationStore
      const history = yield* store.list(initialCid).pipe(
        Effect.catchAll(() => Effect.succeed([])),
      )
      const checkpoints = yield* store.listCheckpoints(initialCid).pipe(
        Effect.catchAll(() => Effect.succeed([])),
      )
      if (history.length > 0) {
        const startupSegments = buildContextView(history, checkpoints)
        yield* Ref.update(stateRef, (s) => {
          replayHistory(s.scrollback, history, checkpoints)
          s.conversationHasTurns = true
          s.sidePane = {
            ...s.sidePane,
            context: startupSegments,
            contextCollapsed: new Set(turnIdsOf(startupSegments)),
          }
          return s
        })
      }
    }

    // First-run guidance (pi-style): with no credential, the agent can't run —
    // point at :login instead of letting the first message 401.
    {
      const bootCreds = yield* (yield* AuthStore).all
      if (Object.keys(bootCreds).length === 0) {
        yield* Ref.update(stateRef, (s) => {
          s.scrollback.push({
            kind: "info",
            text: "No models available. Run :login to add a provider — a subscription (OAuth) or an API key.",
          })
          return s
        })
      }
    }

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

    /**
     * Switch to a model and reflect it in the status bar / side pane. Shared by
     * the `:model <#|id>` path and the `:model` select box's Enter.
     */
    const applyModelSelection = (chosen: ModelInfo) =>
      Effect.gen(function* () {
        const registry = yield* ModelRegistry
        const prev = yield* registry.current
        const sel = yield* registry.select({
          provider: chosen.provider,
          modelId: chosen.modelId,
          ...(chosen.contextWindow > 0 ? { contextWindow: chosen.contextWindow } : {}),
        })
        const st0 = yield* Ref.get(stateRef)
        const crossProvider = prev.provider !== sel.provider && st0.conversationHasTurns
        yield* Ref.update(stateRef, (s) => {
          s.status = { ...s.status, modelId: sel.modelId, contextWindow: sel.contextWindow }
          s.sidePane = {
            ...s.sidePane,
            stats: { ...s.sidePane.stats, contextWindow: sel.contextWindow },
          }
          s.activeProvider = sel.provider
          s.scrollback.push({
            kind: "info",
            text: `switched to ${sel.provider}:${sel.modelId}`,
          })
          if (crossProvider) {
            s.scrollback.push({
              kind: "info",
              text: "note: switched provider mid-conversation; if the next turn errors, /reset (Gemini needs its own tool-call history).",
            })
          }
          return s
        })
      })

    /* ----- in-app `:login` flow ---------------------------------------- */

    // Per-provider status tags for the provider selector.
    const loginStatuses = (auth: AuthData): ReadonlyArray<ProviderStatus> =>
      (["anthropic", "google", "openai"] as const).map((p) => ({
        provider: p,
        configured: auth[p]?.type,
      }))

    // Open the `:login` flow, tagging which providers are already configured.
    const openLoginFlow = Effect.gen(function* () {
      const all = yield* (yield* AuthStore).all
      yield* Ref.update(stateRef, (s) => {
        s.loginFlow = openLogin(loginStatuses(all))
        return s
      })
      yield* requestRender
    })

    // Shared post-login: if the currently-selected model's provider has no
    // credential, switch to the just-configured provider's default model;
    // refresh the status bar and confirm in the rail; close the flow.
    const afterLogin = (provider: Provider, how: string) =>
      Effect.gen(function* () {
        const registry = yield* ModelRegistry
        const auth = yield* AuthStore
        const cur = yield* registry.current
        const curHasCred = (yield* auth.get(cur.provider)) !== undefined
        yield* Ref.update(stateRef, (s) => {
          delete s.loginFlow
          s.scrollback.push({ kind: "info", text: `✓ logged in to ${provider} (${how})` })
          return s
        })
        if (!curHasCred) {
          const { provider: p, modelId } = parseModel(defaultModelForProvider(provider))
          yield* applyModelSelection({
            provider: p,
            modelId,
            displayName: modelId,
            contextWindow: 0,
          })
        }
        yield* requestRender
      })

    // Persist an API key for a provider, then run the post-login steps.
    const commitApiKey = (provider: Provider, key: string) =>
      Effect.gen(function* () {
        const auth = yield* AuthStore
        const ok = yield* auth.setApiKey(provider, key).pipe(
          Effect.as(true),
          Effect.catchAll((e) =>
            Ref.update(stateRef, (s) => {
              delete s.loginFlow
              s.scrollback.push({ kind: "error", text: `login failed: ${e.message}` })
              return s
            }).pipe(Effect.as(false)),
          ),
        )
        if (ok) yield* afterLogin(provider, "api key")
        else yield* requestRender
      })

    // Finish an OAuth login: exchange the code for tokens, persist, run the
    // post-login steps. Stops the callback server either way.
    const finishOAuth = (
      provider: Provider,
      code: string,
      verifier: string,
      stop: () => void,
    ) =>
      Effect.gen(function* () {
        const auth = yield* AuthStore
        const tokens = yield* exchangeAnthropicCode(code, verifier)
        yield* auth.setOAuth(provider, tokens)
        stop()
        yield* Ref.update(stateRef, (s) => {
          delete s.oauthSession
          return s
        })
        yield* afterLogin(provider, "subscription")
      }).pipe(
        Effect.catchAll((e) =>
          Effect.sync(stop).pipe(
            Effect.zipRight(
              Ref.update(stateRef, (s) => {
                delete s.oauthSession
                delete s.loginFlow
                s.scrollback.push({
                  kind: "error",
                  text: `login failed: ${"message" in e ? e.message : String(e)}`,
                })
                return s
              }),
            ),
            Effect.zipRight(requestRender),
          ),
        ),
      )

    // OAuth subscription login: PKCE → open browser + loopback callback server,
    // and race that against a manually-pasted redirect URL.
    const startOAuthLogin = (provider: Provider) =>
      Effect.gen(function* () {
        if (provider !== "anthropic") {
          yield* Ref.update(stateRef, (s) => {
            delete s.loginFlow
            s.scrollback.push({
              kind: "info",
              text: `OAuth subscription login isn't available for ${provider} — use an API key.`,
            })
            return s
          })
          yield* requestRender
          return
        }
        const pkce = yield* generatePkce()
        const url = anthropicAuthorizeUrl(pkce)
        const server = startCallbackServer(ANTHROPIC_CALLBACK_PORT)
        const shell = yield* Shell
        yield* shell
          .exec({ command: browserCommand(url), cwd: input.cwd, timeoutMs: 5_000 })
          .pipe(Effect.catchAll(() => Effect.void))
        yield* Ref.update(stateRef, (s) => {
          if (s.loginFlow) {
            s.loginFlow = loginSetOAuthStatus(s.loginFlow, "waiting for browser login")
          }
          s.scrollback.push({
            kind: "info",
            text: `Opening your browser to log in. If it didn't open, visit:\n${url}`,
          })
          return s
        })
        yield* requestRender
        const waiter = Effect.gen(function* () {
          const { code } = yield* Effect.promise(() => server.waitForCode)
          yield* finishOAuth(provider, code, pkce.verifier, server.stop)
        })
        const fiber = yield* Effect.forkDaemon(waiter)
        yield* Ref.update(stateRef, (s) => {
          s.oauthSession = { verifier: pkce.verifier, stop: server.stop, fiber }
          return s
        })
      })

    // Manual paste of the redirect URL (browser on another machine / no auto-open).
    const completeOAuthManual = (provider: Provider, redirect: string) =>
      Effect.gen(function* () {
        const session = (yield* Ref.get(stateRef)).oauthSession
        const parsed = parseAuthorizationInput(redirect)
        if (parsed.code === undefined) {
          yield* Ref.update(stateRef, (s) => {
            s.scrollback.push({
              kind: "error",
              text: "couldn't find an authorization code in that input",
            })
            return s
          })
          yield* requestRender
          return
        }
        if (session !== undefined) yield* Fiber.interrupt(session.fiber)
        const verifier = session?.verifier ?? parsed.state ?? ""
        yield* finishOAuth(provider, parsed.code, verifier, session?.stop ?? (() => {}))
      })

    // Tear down an in-flight OAuth login (callback server + waiter) on cancel.
    const stopOAuthSession = Ref.get(stateRef).pipe(
      Effect.flatMap((s) => {
        const sess = s.oauthSession
        if (sess === undefined) return Effect.void
        sess.stop()
        return Fiber.interrupt(sess.fiber).pipe(
          Effect.zipRight(
            Ref.update(stateRef, (st) => {
              delete st.oauthSession
              return st
            }),
          ),
        )
      }),
    )

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

    // Startup meta (model · cwd · logs · key hints) no longer clutters the
    // scrollback — model/cwd/tokens live in the status bar, and the logs path
    // plus key hints render as a fixed dim footer below it (see `footer`).

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
    // edit/write paths captured at call-start, for the files-changed diffstat.
    const toolPath = new Map<string, string>()
    // sub-agent name → scrollback pill id, so subagent_end can update it.
    const subAgentScrollId = new Map<string, string>()
    let subAgentDepth = 0
    let toolSeq = 0
    const isDelegate = (name: string): boolean => name.startsWith("delegate_to_")
    // Join the present detail parts with ` · `, or undefined when none apply.
    const joinDetail = (
      ...parts: ReadonlyArray<string | undefined>
    ): string | undefined =>
      parts.filter((p): p is string => p !== undefined).join(" · ") || undefined
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
                if (event.toolName === "edit_file" || event.toolName === "write_file") {
                  const p = (event.args as { path?: unknown }).path
                  if (typeof p === "string") toolPath.set(event.toolName, p)
                }
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
                  const artifacts = toolArtifacts(
                    event.toolName,
                    event.ok,
                    event.result,
                  )
                  s.scrollback.updateTool(sid, {
                    state: event.ok ? "ok" : "error",
                    ...(detail !== undefined ? { detail } : {}),
                    ...(artifacts.diff !== undefined ? { diff: artifacts.diff } : {}),
                    ...(artifacts.output !== undefined
                      ? { output: artifacts.output }
                      : {}),
                  })
                  toolScrollId.delete(event.toolName)
                }
                // Files-changed diffstat (edit/write only, on success).
                if (
                  event.ok &&
                  (event.toolName === "edit_file" || event.toolName === "write_file")
                ) {
                  const path = toolPath.get(event.toolName)
                  toolPath.delete(event.toolName)
                  if (path !== undefined) {
                    let added = 0
                    let removed = 0
                    if (detail !== undefined) {
                      const m = /\+(\d+)\/-(\d+)/.exec(detail)
                      if (m !== null) {
                        added = Number(m[1])
                        removed = Number(m[2])
                      } else {
                        const w = /(\d+)/.exec(detail) // write_file: "wrote N lines"
                        if (w !== null) added = Number(w[1])
                      }
                    }
                    const prevFiles = s.sidePane.filesChanged
                    const existing = prevFiles.find((f) => f.path === path)
                    const next: FileChange =
                      existing !== undefined
                        ? { path, added: existing.added + added, removed: existing.removed + removed }
                        : { path, added, removed }
                    s.sidePane = {
                      ...s.sidePane,
                      filesChanged:
                        existing !== undefined
                          ? prevFiles.map((f) => (f.path === path ? next : f))
                          : [...prevFiles, next],
                    }
                  }
                }
                break
              }
              case "subagent_start": {
                subAgentDepth++
                const label = `Task(${event.name})`
                toolSeq++
                const sid = `sa${toolSeq}`
                subAgentScrollId.set(event.name, sid)
                s.scrollback.push({
                  kind: "tool",
                  id: sid,
                  toolName: label,
                  state: "running",
                  output: event.task,
                })
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
                // Update the running pill to ok/error with a short detail.
                const endSid = subAgentScrollId.get(event.name)
                if (endSid !== undefined) {
                  const pillDetail = joinDetail(
                    filesDetail,
                    event.usage !== undefined
                      ? `${formatTokens(event.usage.inputTokens)} ctx · ${formatTokens(event.usage.outputTokens)} out`
                      : undefined,
                  )
                  s.scrollback.updateTool(endSid, {
                    state: event.ok ? "ok" : "error",
                    ...(pillDetail !== undefined ? { detail: pillDetail } : {}),
                  })
                  subAgentScrollId.delete(event.name)
                }
                // Push the summary as an assistant block so it's visible as a reply.
                if (event.ok && event.summary.trim().length > 0) {
                  s.scrollback.push({ kind: "assistant", text: event.summary })
                }
                const nodeDetail = joinDetail(
                  filesDetail,
                  event.usage !== undefined
                    ? `${formatTokens(event.usage.inputTokens)} ctx`
                    : undefined,
                )
                s.sidePane = {
                  ...s.sidePane,
                  tree: treeSubAgentEnd(
                    s.sidePane.tree,
                    event.ok,
                    nodeDetail,
                    now,
                  ),
                }
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
                // Reasoning renders above the answer for this step (and, since
                // the loop emits this before the step's tool events, above its
                // tool pills too).
                if (event.reasoning !== undefined && event.reasoning.trim().length > 0) {
                  s.scrollback.push({ kind: "reasoning", text: event.reasoning })
                }
                if (event.text.trim().length > 0) {
                  s.scrollback.push({ kind: "assistant", text: event.text })
                }
                if (event.usage !== undefined) {
                  const u = event.usage
                  s.status = {
                    ...s.status,
                    inputTokens: u.inputTokens,
                    cacheReadTokens: u.cacheReadTokens,
                  }
                  const prev = s.sidePane.stats
                  s.sidePane = {
                    ...s.sidePane,
                    // Cumulative output/total; input/cache reflect the latest call.
                    stats: {
                      ...prev,
                      inputTokens: u.inputTokens,
                      cacheReadTokens: u.cacheReadTokens,
                      outputTokens: prev.outputTokens + u.outputTokens,
                      totalTokens: prev.totalTokens + u.totalTokens,
                      turns: prev.turns + 1,
                    },
                    // Per-LLM-call output on the open turn node, e.g. `340 tok`
                    // (what the model generated this turn; context is the header gauge).
                    tree: treeTurnDetail(
                      s.sidePane.tree,
                      `${formatTokens(u.outputTokens)} tok`,
                    ),
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
                    text: `(agent stopped without a final answer — see ~/.efferent/efferent.log)`,
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

    type R_Base = FileSystem | Http | Shell | ConversationStore | LanguageModel.LanguageModel | SettingsStore | ModelRegistry | WebSearch | AuthStore
    const baseHooks = makeEventHooks(eventQueue)
    // Build the root scope runtime once: base coding tools + delegate_to_<child>
    // tools for the root's direct sub-scopes. The TUI allows bash (guarded by
    // the confirm modal hook, not the allowBash flag). `baseHooks` is captured
    // so delegation emits subagent_start/end onto the event queue.
    const scopeRuntime = buildScopeRuntime(
      input.rootScope,
      { skills: input.skills, allowBash: true },
      baseHooks,
    )

    const submit = (
      text: string,
    ): Effect.Effect<void, never, R_Base> =>
      Effect.gen(function* () {
        const cur = yield* Ref.get(stateRef)

        // No provider configured → guide to :login instead of a deep 401.
        const authAll = yield* (yield* AuthStore).all
        if (Object.keys(authAll).length === 0) {
          cur.scrollback.push({ kind: "user", text })
          cur.scrollback.push({
            kind: "info",
            text: "no provider configured — run :login to add one (subscription or API key)",
          })
          cur.scrollback.stickToBottom()
          yield* Ref.update(stateRef, (s) => {
            s.input = emptyInput
            return s
          })
          yield* requestRender
          return
        }

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
        cur.scrollback.cursorToBottom()
        cur.scrollback.clearSearch()
        yield* Ref.update(stateRef, (s) => {
          s.input = emptyInput
          s.busy = true
          s.turnStartedAt = Date.now()
          s.spinnerFrame = 0
          s.currentTurn = 0
          s.conversationHasTurns = true
          // Collapse all activity-pane tree nodes from the previous run when a
          // new user message comes in, so the next run starts with a clean
          // expanded view.
          const collapsed = new Set(s.sidePane.stackCollapsed)
          const collectContainerIds = (nodes: ReadonlyArray<TreeNode>): void => {
            for (const n of nodes) {
              if (n.kind === "turn" || n.kind === "subagent") {
                collapsed.add(`node:${n.id}`)
              }
              collectContainerIds(n.children)
            }
          }
          collectContainerIds(s.sidePane.tree.roots)
          s.sidePane = { ...s.sidePane, stackCollapsed: collapsed }
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
          subAgentScrollId.clear()
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
          coderAgentConfig(input.rootScope, scopeRuntime),
          cid,
          text,
          baseHooks,
          input.cwd,
        ).pipe(
          Effect.provide(scopeRuntime.handlerLayer),
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

    // Last `:browse` listing, so `:resume <#>` can resolve a numbered choice.
    let browseList: ReadonlyArray<{
      readonly id: string
      readonly createdAt: number
      readonly firstPrompt?: string
    }> = []

    // Rebuild the context-viewer model from the persisted record: full history
    // (browsable) + checkpoints (the folds). Cheap; called on resume, after a
    // handoff, and when `:context` opens.
    const rebuildContext = (cid: ConversationId) =>
      Effect.gen(function* () {
        const store = yield* ConversationStore
        const history = yield* store
          .list(cid)
          .pipe(Effect.catchAll(() => Effect.succeed([])))
        const checkpoints = yield* store
          .listCheckpoints(cid)
          .pipe(Effect.catchAll(() => Effect.succeed([])))
        const segments = buildContextView(history, checkpoints)
        yield* Ref.update(stateRef, (s) => {
          s.sidePane = {
            ...s.sidePane,
            context: segments,
            // Start with turns folded → a clean, selectable list of turn
            // subjects; cursor at the top; nothing selected yet.
            contextCollapsed: new Set(turnIdsOf(segments)),
            contextSelected: new Set(),
            contextHandoffSelected: new Set(),
            contextCursor: 0,
          }
          return s
        })
      })

    // Build a brand-new conversation seeded with the turns the user picked in
    // the context viewer, then switch the TUI to it (the old one is untouched).
    // Mirrors the `:resume` switch — create + append + replay + focus the input.
    const doBuildSession = Effect.gen(function* () {
      const cur = yield* Ref.get(stateRef)
      if (cur.busy) {
        yield* Ref.update(stateRef, (s) => {
          s.scrollback.push({ kind: "info", text: "can't build a session while a turn is running" })
          return s
        })
        yield* requestRender
        return
      }
      const segs = cur.sidePane.context ?? []
      const picked = messagesForSelectedTurns(
        segs,
        cur.sidePane.contextSelected,
        cur.sidePane.contextHandoffSelected,
      )
      const turnCount = cur.sidePane.contextSelected.size
      const handoffCount = cur.sidePane.contextHandoffSelected.size
      if (picked.length === 0) {
        yield* Ref.update(stateRef, (s) => {
          s.scrollback.push({
            kind: "info",
            text: "nothing selected — in :context, Space to pick turns or a handoff, then b to build",
          })
          return s
        })
        yield* requestRender
        return
      }
      const store = yield* ConversationStore
      const created = yield* store.create(input.cwd).pipe(Effect.either)
      if (created._tag === "Left") {
        yield* Ref.update(stateRef, (s) => {
          s.scrollback.push({ kind: "info", text: "failed to create the new session" })
          return s
        })
        yield* requestRender
        return
      }
      const newId = created.right
      yield* Effect.forEach(picked, (m) =>
        store.append(newId, m).pipe(Effect.catchAll(() => Effect.void)),
      )
      yield* Ref.update(stateRef, (s) => {
        s.conversationId = newId
        s.scrollback.clear()
        s.sidePane = {
          ...s.sidePane,
          tree: emptyTree,
          view: "stack",
          context: buildContextView(picked, []),
          contextCollapsed: new Set(),
          contextSelected: new Set(),
          contextHandoffSelected: new Set(),
          contextCursor: 0,
          stats: {
            ...emptyStats,
            startedAt: Date.now(),
            contextWindow: s.sidePane.stats.contextWindow,
          },
          filesChanged: [],
          stackCollapsed: new Set(["files", "skills", "instructions"]),
          stackCursor: 0,
        }
        replayHistory(s.scrollback, picked, [])
        s.scrollback.cursorToBottom()
        s.conversationHasTurns = picked.length > 0
        s.focus = "input"
        s.mode = "insert"
        const units = [
          turnCount > 0 ? `${turnCount} turn${turnCount === 1 ? "" : "s"}` : "",
          handoffCount > 0 ? `${handoffCount} handoff${handoffCount === 1 ? "" : "s"}` : "",
        ]
          .filter((x) => x !== "")
          .join(" + ")
        s.scrollback.push({
          kind: "info",
          text: `built new session ${newId.slice(0, 8)} · ${units} · ${picked.length} msgs`,
        })
        return s
      })
      yield* requestRender
    })

    const handleSlash = (cmd: string) =>
      Effect.gen(function* () {
        const parts = cmd.trim().split(/\s+/)
        const baseCmd = parts[0]
        switch (baseCmd) {
          case ":exit":
          case ":quit":
            return "exit" as const
          case ":clear":
            yield* Ref.update(stateRef, (s) => {
              s.scrollback.clear()
              s.sidePane = { ...s.sidePane, tree: emptyTree }
              return s
            })
            yield* requestRender
            return "stay" as const
          case ":handoff": {
            const cur0 = yield* Ref.get(stateRef)
            if (cur0.busy) {
              yield* Ref.update(stateRef, (s) => {
                s.scrollback.push({
                  kind: "info",
                  text: "can't hand off while a turn is running",
                })
                return s
              })
              yield* requestRender
              return "stay" as const
            }
            const hcid = cur0.conversationId
            yield* Effect.gen(function* () {
              yield* Ref.update(stateRef, (s) => {
                s.busy = true
                s.scrollback.push({ kind: "info", text: "⟳ generating handoff…" })
                return s
              })
              yield* requestRender

              // createHandoff needs only ConversationStore + LanguageModel,
              // both ambient — no toolkit handler layer required.
              yield* createHandoff(hcid).pipe(
                Effect.catchAll((err) => {
                  const msg =
                    typeof err === "object" && err !== null && "message" in err
                      ? String((err as { message: unknown }).message)
                      : String(err)
                  return Queue.offer(eventQueue, {
                    type: "error",
                    message: `handoff failed: ${msg}`,
                  })
                }),
              )

              const store = yield* ConversationStore
              const cp = yield* store
                .getLatestCheckpoint(hcid)
                .pipe(Effect.catchAll(() => Effect.succeed(undefined)))

              yield* rebuildContext(hcid)
              yield* Ref.update(stateRef, (s) => {
                s.busy = false
                if (cp !== undefined) {
                  s.scrollback.push({ kind: "checkpoint", text: cp.summary })
                } else {
                  s.scrollback.push({
                    kind: "info",
                    text: "nothing new to hand off",
                  })
                }
                return s
              })
              yield* requestRender
            })
            return "stay" as const
          }
          case ":context": {
            const cur0 = yield* Ref.get(stateRef)
            yield* rebuildContext(cur0.conversationId)
            yield* Ref.update(stateRef, (s) => {
              const next = s.sidePane.view === "context" ? "stack" : "context"
              // Reset the tree cursor to the top each time the viewer opens.
              s.sidePane = { ...s.sidePane, view: next, contextCursor: 0 }
              if (next === "context") {
                s.focus = "side"
                s.mode = "normal" // enable the side block cursor + tree nav
              } else if (s.focus === "side") {
                s.focus = "input"
                s.mode = "insert"
              }
              return s
            })
            yield* requestRender
            return "stay" as const
          }
          case ":build": {
            yield* doBuildSession
            return "stay" as const
          }
          case ":browse": {
            const store = yield* ConversationStore
            const list = yield* store
              .listByWorkspace(input.cwd)
              .pipe(Effect.catchAll(() => Effect.succeed([])))
            browseList = list
            yield* Ref.update(stateRef, (s) => {
              s.scrollback.push({
                kind: "info",
                text: `conversations in ${input.cwd}:`,
              })
              if (list.length === 0) {
                s.scrollback.push({ kind: "info", text: "  (none)" })
              } else {
                list.forEach((c, i) => {
                  const date = new Date(c.createdAt).toLocaleString()
                  const preview =
                    c.firstPrompt !== undefined &&
                    c.firstPrompt.trim().length > 0
                      ? c.firstPrompt.trim().replace(/\s+/g, " ").slice(0, 50)
                      : "(empty)"
                  const here = c.id === s.conversationId ? " ← current" : ""
                  s.scrollback.push({
                    kind: "info",
                    text: `  [${i + 1}] ${date} · ${preview}${here}`,
                  })
                })
                s.scrollback.push({
                  kind: "info",
                  text: "  :resume <#> to open one",
                })
              }
              return s
            })
            yield* requestRender
            return "stay" as const
          }
          case ":resume": {
            const cur0 = yield* Ref.get(stateRef)
            if (cur0.busy) {
              yield* Ref.update(stateRef, (s) => {
                s.scrollback.push({
                  kind: "info",
                  text: "can't resume while a turn is running",
                })
                return s
              })
              yield* requestRender
              return "stay" as const
            }
            const arg = parts[1]
            if (arg === undefined) {
              yield* Ref.update(stateRef, (s) => {
                s.scrollback.push({
                  kind: "info",
                  text: "usage: :resume <#|id> (run :browse first)",
                })
                return s
              })
              yield* requestRender
              return "stay" as const
            }
            const n = Number(arg)
            const rawId =
              Number.isInteger(n) && n >= 1 && n <= browseList.length
                ? browseList[n - 1]!.id
                : arg
            const target = yield* decodeConversationId(rawId).pipe(
              Effect.catchAll(() => Effect.succeed(undefined)),
            )
            if (target === undefined) {
              yield* Ref.update(stateRef, (s) => {
                s.scrollback.push({
                  kind: "info",
                  text: `not a conversation: ${arg}`,
                })
                return s
              })
              yield* requestRender
              return "stay" as const
            }
            const store = yield* ConversationStore
            const history = yield* store
              .list(target)
              .pipe(Effect.catchAll(() => Effect.succeed([])))
            const checkpoints = yield* store
              .listCheckpoints(target)
              .pipe(Effect.catchAll(() => Effect.succeed([])))
            const resumedSegments = buildContextView(history, checkpoints)
            yield* Ref.update(stateRef, (s) => {
              s.conversationId = target
              s.scrollback.clear()
              s.sidePane = {
                ...s.sidePane,
                tree: emptyTree,
                context: resumedSegments,
                contextCollapsed: new Set(turnIdsOf(resumedSegments)),
                contextSelected: new Set(),
                contextHandoffSelected: new Set(),
                contextCursor: 0,
                stats: {
                  ...emptyStats,
                  startedAt: Date.now(),
                  contextWindow: s.sidePane.stats.contextWindow,
                },
                filesChanged: [],
                stackCollapsed: new Set(["files", "skills", "instructions"]),
                stackCursor: 0,
              }
              replayHistory(s.scrollback, history, checkpoints)
              s.scrollback.cursorToBottom()
              s.conversationHasTurns = history.length > 0
              s.scrollback.push({
                kind: "info",
                text: `resumed ${target.slice(0, 8)} · ${history.length} msgs loaded for browsing`,
              })
              return s
            })
            yield* requestRender
            return "stay" as const
          }
          case ":help":
            yield* Ref.update(stateRef, (s) => {
              for (const line of HELP_LINES) {
                s.scrollback.push({ kind: "info", text: line })
              }
              return s
            })
            yield* requestRender
            return "stay" as const
          case ":cwd":
            yield* Ref.update(stateRef, (s) => {
              s.scrollback.push({ kind: "info", text: `cwd: ${input.cwd}` })
              return s
            })
            yield* requestRender
            return "stay" as const
          case ":reset":
            yield* Ref.update(stateRef, (s) => {
              s.conversationId = newConversationId()
              s.sidePane = { ...s.sidePane, tree: emptyTree }
              s.conversationHasTurns = false
              s.scrollback.push({
                kind: "info",
                text: `new conversation: ${s.conversationId.slice(0, 8)}`,
              })
              return s
            })
            yield* requestRender
            return "stay" as const
          case ":settings": {
            const settingsStore = yield* SettingsStore
            const current = yield* settingsStore.get()
            // Report the *active* store (what's actually connected), derived
            // from the live EFFERENT_DB_URL the selector used — env, or seeded
            // from config.json. The config value alone is misleading (an env
            // var overrides it).
            const db = describeActiveDatabase(
              process.env.EFFERENT_DB_URL,
              current.dbUrl,
            )
            yield* Ref.update(stateRef, (s) => {
              s.scrollback.push({ kind: "info", text: "--- Configuration Settings ---" })
              s.scrollback.push({ kind: "info", text: `allowBash: ${current.allowBash}` })
              s.scrollback.push({ kind: "info", text: `maxSteps: ${current.maxSteps}` })
              s.scrollback.push({ kind: "info", text: `model: ${current.model}` })
              s.scrollback.push({ kind: "info", text: db.line })
              if (db.overrideNote !== undefined) {
                s.scrollback.push({ kind: "info", text: db.overrideNote })
              }
              return s
            })
            yield* requestRender
            return "stay" as const
          }
          case ":set": {
            const k = parts[1]
            const v = parts.slice(2).join(" ")
            if (!k || !v) {
              yield* Ref.update(stateRef, (s) => {
                s.scrollback.push({
                  kind: "error",
                  text: "Usage: :set <key> <value> (e.g. :set maxSteps 15)",
                })
                return s
              })
              yield* requestRender
              return "stay" as const
            }

            const settingsStore = yield* SettingsStore
            const current = yield* settingsStore.get()

            const validKeys: ReadonlyArray<keyof typeof current> = ["allowBash", "maxSteps"]
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
          case ":db": {
            // Show or change the conversation store. The active store is bound
            // at boot, so a change is persisted (project or global config) and
            // takes effect on the next launch.
            const tokens = parts.slice(1).filter((t) => t.length > 0)
            const wantGlobal = tokens.some((t) => t.toLowerCase() === "global")
            const args = tokens.filter((t) => t.toLowerCase() !== "global")

            if (args.length === 0) {
              const settingsStore = yield* SettingsStore
              const current = yield* settingsStore.get()
              const db = describeActiveDatabase(
                process.env.EFFERENT_DB_URL,
                current.dbUrl,
              )
              yield* Ref.update(stateRef, (s) => {
                s.scrollback.push({ kind: "info", text: db.line })
                if (db.overrideNote !== undefined) {
                  s.scrollback.push({ kind: "info", text: db.overrideNote })
                }
                s.scrollback.push({
                  kind: "info",
                  text: "set: :db pg <url> [global] · :db sqlite [path] [global] (applies next launch)",
                })
                return s
              })
              yield* requestRender
              return "stay" as const
            }

            const head = args[0]!.toLowerCase()
            let dbUrl: string // "" → reset to default SQLite
            if (head === "sqlite") {
              dbUrl = args[1] ?? ""
            } else if (head === "pg" || head === "postgres" || head === "postgresql") {
              dbUrl = args.slice(1).join(" ").trim()
              if (dbUrl.length === 0) {
                yield* Ref.update(stateRef, (s) => {
                  s.scrollback.push({
                    kind: "error",
                    text: "Usage: :db pg <postgres://… connection string> [global]",
                  })
                  return s
                })
                yield* requestRender
                return "stay" as const
              }
            } else {
              dbUrl = args.join(" ").trim() // raw value (a postgres:// URL or a path)
            }

            const fs = yield* FileSystem
            const cfgPath = wantGlobal
              ? join(homedir(), ".efferent", "config.json")
              : join(input.cwd, ".efferent", "config.json")
            const exists = yield* fs
              .exists(cfgPath)
              .pipe(Effect.orElseSucceed(() => false))
            let cfg: Record<string, unknown> = {}
            if (exists) {
              const read = yield* fs.read(cfgPath).pipe(Effect.either)
              if (read._tag === "Right") {
                try {
                  cfg = JSON.parse(read.right.content) as Record<string, unknown>
                } catch {
                  /* overwrite malformed config */
                }
              }
            }
            if (dbUrl.length > 0) cfg.dbUrl = dbUrl
            else delete cfg.dbUrl
            const writeResult = yield* fs
              .write(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`)
              .pipe(Effect.either)

            yield* Ref.update(stateRef, (s) => {
              if (writeResult._tag === "Left") {
                s.scrollback.push({
                  kind: "error",
                  text: `Failed to write ${cfgPath}: ${String(writeResult.left)}`,
                })
                return s
              }
              const scope = wantGlobal ? "global (~/.efferent)" : "project (.efferent)"
              const target =
                dbUrl.length > 0
                  ? maskDbUrl(dbUrl)
                  : "SQLite default (~/.efferent/efferent.db)"
              s.scrollback.push({
                kind: "info",
                text: `database → ${target} · saved to ${scope} config · relaunch efferent to connect`,
              })
              return s
            })
            yield* requestRender
            return "stay" as const
          }
          case ":model": {
            const registry = yield* ModelRegistry
            const arg = parts.slice(1).join(" ").trim()

            // No arg → fetch the live catalogue and open the select box.
            if (arg.length === 0) {
              yield* Ref.update(stateRef, (s) => {
                s.scrollback.push({ kind: "info", text: "fetching models…" })
                return s
              })
              yield* requestRender
              const models = yield* registry.list.pipe(
                Effect.catchAll((e) =>
                  Ref.update(stateRef, (s) => {
                    s.scrollback.push({
                      kind: "error",
                      text: `failed to list ${e.provider} models: ${e.message}`,
                    })
                    return s
                  }).pipe(Effect.as([] as ReadonlyArray<ModelInfo>)),
                ),
              )
              const cur = yield* registry.current
              if (models.length === 0) {
                yield* Ref.update(stateRef, (s) => {
                  s.scrollback.push({
                    kind: "info",
                    text: "no models available — run :login to add a provider (subscription or API key)",
                  })
                  return s
                })
                yield* requestRender
                return "stay" as const
              }
              const options = models.map((m) => ({
                value: m,
                label: `${m.provider}:${m.modelId}`,
                active: m.provider === cur.provider && m.modelId === cur.modelId,
              }))
              yield* Ref.update(stateRef, (s) => {
                s.modelList = models
                s.modelPicker = openSelect("Select a model", options)
                return s
              })
              yield* requestRender
              return "stay" as const
            }

            // `<#|id>` → resolve directly (no box) and switch. A number indexes
            // the last listing; otherwise treat it as a (provider-prefixed) id.
            const list = (yield* Ref.get(stateRef)).modelList ?? []
            let chosen: ModelInfo | undefined
            const asNum = Number(arg)
            if (Number.isInteger(asNum) && asNum >= 1 && asNum <= list.length) {
              chosen = list[asNum - 1]
            } else {
              const { provider, modelId } = parseModel(arg)
              chosen =
                list.find((m) => m.provider === provider && m.modelId === modelId) ??
                list.find((m) => m.modelId === modelId)
              if (chosen === undefined && arg.includes(":")) {
                chosen = { provider, modelId, displayName: modelId, contextWindow: 0 }
              }
            }

            if (chosen === undefined) {
              yield* Ref.update(stateRef, (s) => {
                s.scrollback.push({
                  kind: "error",
                  text: `unknown model '${arg}'. Run :model to pick from the list.`,
                })
                return s
              })
              yield* requestRender
              return "stay" as const
            }

            yield* applyModelSelection(chosen)
            yield* requestRender
            return "stay" as const
          }
          case ":login": {
            yield* openLoginFlow
            return "stay" as const
          }
          case ":logout": {
            const auth = yield* AuthStore
            const all = yield* auth.all
            const arg = parts.slice(1).join(" ").trim().toLowerCase()
            const configured = (["anthropic", "google", "openai"] as const).filter(
              (p) => all[p] !== undefined,
            )
            if (arg.length === 0) {
              yield* Ref.update(stateRef, (s) => {
                s.scrollback.push({
                  kind: "info",
                  text:
                    configured.length === 0
                      ? "no providers configured — :login to add one"
                      : `configured: ${configured.join(", ")} · :logout <provider> to remove one`,
                })
                return s
              })
              yield* requestRender
              return "stay" as const
            }
            if (arg !== "anthropic" && arg !== "google" && arg !== "openai") {
              yield* Ref.update(stateRef, (s) => {
                s.scrollback.push({
                  kind: "error",
                  text: `unknown provider '${arg}' (anthropic | google | openai)`,
                })
                return s
              })
              yield* requestRender
              return "stay" as const
            }
            const provider: Provider = arg
            yield* auth.remove(provider).pipe(
              Effect.flatMap(() =>
                Ref.update(stateRef, (s) => {
                  s.scrollback.push({ kind: "info", text: `logged out of ${provider}` })
                  return s
                }),
              ),
              Effect.catchAll((e) =>
                Ref.update(stateRef, (s) => {
                  s.scrollback.push({ kind: "error", text: `logout failed: ${e.message}` })
                  return s
                }),
              ),
            )
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

    const handleKey = (key: Key): Effect.Effect<"stay" | "exit", never, FileSystem | Http | Shell | ConversationStore | LanguageModel.LanguageModel | SettingsStore | ModelRegistry | WebSearch | AuthStore> =>
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

        // The `:model` select box owns all input while open.
        if (s.modelPicker !== undefined) {
          if (key.type === "escape" || (key.type === "ctrl" && key.char === "c")) {
            yield* Ref.update(stateRef, (st) => {
              delete st.modelPicker
              return st
            })
            yield* requestRender
            return "stay" as const
          }
          if (key.type === "arrow" && (key.dir === "up" || key.dir === "down")) {
            const dir: "up" | "down" = key.dir === "up" ? "up" : "down"
            yield* Ref.update(stateRef, (st) => {
              if (st.modelPicker) st.modelPicker = moveSelect(st.modelPicker, dir)
              return st
            })
            yield* requestRender
            return "stay" as const
          }
          if (key.type === "backspace") {
            yield* Ref.update(stateRef, (st) => {
              if (st.modelPicker) st.modelPicker = filterBackspace(st.modelPicker)
              return st
            })
            yield* requestRender
            return "stay" as const
          }
          if (key.type === "char") {
            const ch = key.char
            yield* Ref.update(stateRef, (st) => {
              if (st.modelPicker) st.modelPicker = filterAppend(st.modelPicker, ch)
              return st
            })
            yield* requestRender
            return "stay" as const
          }
          if (key.type === "enter") {
            const chosen = selectedValue(s.modelPicker)
            yield* Ref.update(stateRef, (st) => {
              delete st.modelPicker
              return st
            })
            if (chosen !== undefined) yield* applyModelSelection(chosen)
            yield* requestRender
            return "stay" as const
          }
          return "stay" as const
        }

        // The `:login` flow owns all input while open (Esc steps back / closes).
        if (s.loginFlow !== undefined) {
          const flow = s.loginFlow
          if (key.type === "escape") {
            // Leaving the OAuth step cancels any in-flight callback server.
            if (flow.step === "oauth") yield* stopOAuthSession
            const back = loginBack(flow)
            yield* Ref.update(stateRef, (st) => {
              if (back === undefined) delete st.loginFlow
              else st.loginFlow = back
              return st
            })
            yield* requestRender
            return "stay" as const
          }
          if (key.type === "ctrl" && key.char === "c") {
            yield* stopOAuthSession
            yield* Ref.update(stateRef, (st) => {
              delete st.loginFlow
              return st
            })
            yield* requestRender
            return "stay" as const
          }
          if (key.type === "arrow" && (key.dir === "up" || key.dir === "down")) {
            const dir: "up" | "down" = key.dir === "up" ? "up" : "down"
            yield* Ref.update(stateRef, (st) => {
              if (st.loginFlow) st.loginFlow = loginMove(st.loginFlow, dir)
              return st
            })
            yield* requestRender
            return "stay" as const
          }
          if (key.type === "backspace") {
            yield* Ref.update(stateRef, (st) => {
              if (st.loginFlow) st.loginFlow = loginBackspace(st.loginFlow)
              return st
            })
            yield* requestRender
            return "stay" as const
          }
          if (key.type === "char") {
            const ch = key.char
            yield* Ref.update(stateRef, (st) => {
              if (st.loginFlow) st.loginFlow = loginAppend(st.loginFlow, ch)
              return st
            })
            yield* requestRender
            return "stay" as const
          }
          if (key.type === "enter") {
            const outcome = loginAdvance(flow)
            switch (outcome.kind) {
              case "flow":
                yield* Ref.update(stateRef, (st) => {
                  st.loginFlow = outcome.flow
                  return st
                })
                yield* requestRender
                break
              case "apiKey":
                yield* commitApiKey(outcome.provider, outcome.key)
                break
              case "startOAuth":
                yield* Ref.update(stateRef, (st) => {
                  st.loginFlow = outcome.flow
                  return st
                })
                yield* requestRender
                yield* startOAuthLogin(outcome.provider)
                break
              case "oauthManual":
                yield* completeOAuthManual(outcome.provider, outcome.redirect)
                break
              case "none":
                break
            }
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

        // Ctrl-R: expand/collapse full tool output + diffs in the scrollback.
        if (key.type === "ctrl" && key.char === "r") {
          yield* Ref.update(stateRef, (st) => {
            const on = st.scrollback.toggleExpanded()
            st.scrollback.push({
              kind: "info",
              text: on ? "tool output expanded (Ctrl-R to collapse)" : "tool output collapsed",
            })
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
              // Complete into the command body without the `:` (the prompt
              // shows it); stay in command entry so you can add args.
              const body = cmd.name.slice(1)
              yield* Ref.update(stateRef, (st) => {
                st.input = { lines: [body], row: 0, col: body.length, locked: false }
                st.palette = computePalette(cmd.name)
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
                st.entry = "message"
                return st
              })
              const outcome = yield* handleSlash(cmd.name)
              return outcome === "exit" ? ("exit" as const) : ("stay" as const)
            }
            return "stay" as const
          }
        }

        const cols = getTermSize().cols
        const intent = decideKey(
          {
            focus: s.focus,
            mode: s.mode,
            entry: s.entry,
            inputEmpty: inputText(s.input).length === 0,
            searchActive: s.scrollback.searchActive(),
            navPending: s.navPending === "g",
            sideVisible: cols >= 60,
            zoomed: s.zoomed,
            view: s.sidePane.view,
          },
          key,
        )

        switch (intent.kind) {
          // Hand the key to the input editor (typing / vi motions / submit).
          case "input": {
            const viMode = s.mode === "insert" ? "insert" : "normal"
            const r = applyViKey({ ...s.vi, mode: viMode }, s.input, key, cols)
            const nextMode: UiMode = r.vi.mode === "insert" ? "insert" : "normal"
            const newPalette = computePalette(inputText(r.input))
            yield* Ref.update(stateRef, (st) => {
              st.input = r.input
              st.vi = r.vi
              st.mode = nextMode
              st.palette = newPalette
              st.navPending = undefined
              return st
            })
            if (r.action !== undefined) {
              switch (r.action.type) {
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
                  if (r.action.text.startsWith(":")) {
                    const outcome = yield* handleSlash(r.action.text.trim())
                    if (outcome === "exit") return "exit" as const
                    return "stay" as const
                  }
                  yield* submit(r.action.text)
                  return "stay" as const
                }
              }
            }
            yield* requestRender
            return "stay" as const
          }

          case "focus":
            yield* Ref.update(stateRef, (st) => {
              // Swapping panes leaves zoom (you can't be zoomed on a hidden /
              // input pane). Entering the conversation places its cursor.
              st.zoomed = false
              st.focus = intent.to
              st.mode = intent.mode
              st.navPending = undefined
              st.palette = hiddenPalette
              if (intent.to === "conversation") st.scrollback.initCursor()
              st.scrollback.endVisual()
              return st
            })
            yield* requestRender
            return "stay" as const

          case "scroll":
            yield* Ref.update(stateRef, (st) => {
              applyScroll(st.scrollback, intent.op)
              st.navPending = undefined
              return st
            })
            yield* requestRender
            return "stay" as const

          case "cursorMove":
            yield* Ref.update(stateRef, (st) => {
              applyCursorMove(st.scrollback, intent.op)
              st.navPending = undefined
              return st
            })
            yield* requestRender
            return "stay" as const

          case "gPending":
            yield* Ref.update(stateRef, (st) => {
              st.navPending = "g"
              return st
            })
            yield* requestRender
            return "stay" as const

          case "foldToggle":
            yield* Ref.update(stateRef, (st) => {
              st.scrollback.foldToggleAtCursor()
              st.navPending = undefined
              return st
            })
            yield* requestRender
            return "stay" as const

          case "foldAll":
            yield* Ref.update(stateRef, (st) => {
              st.scrollback.setAllFolded(!st.scrollback.anyFolded())
              st.navPending = undefined
              return st
            })
            yield* requestRender
            return "stay" as const

          case "sideCursorMove":
            yield* Ref.update(stateRef, (st) => {
              const op = intent.op
              st.sidePane =
                op === "top"
                  ? sideCursorToTop(st.sidePane)
                  : op === "bottom"
                    ? sideCursorToEnd(st.sidePane)
                    : sideCursorMove(st.sidePane, op === "down" ? 1 : -1)
              st.navPending = undefined
              return st
            })
            yield* requestRender
            return "stay" as const

          case "sideToggleNode":
            yield* Ref.update(stateRef, (st) => {
              st.sidePane = sideToggleNode(st.sidePane)
              st.navPending = undefined
              return st
            })
            yield* requestRender
            return "stay" as const

          case "stackCursorMove":
            yield* Ref.update(stateRef, (st) => {
              const op = intent.op
              st.sidePane =
                op === "top"
                  ? stackCursorToTop(st.sidePane)
                  : op === "bottom"
                    ? stackCursorToEnd(st.sidePane)
                    : stackCursorMove(st.sidePane, op === "down" ? 1 : -1)
              st.navPending = undefined
              return st
            })
            yield* requestRender
            return "stay" as const

          case "stackToggle":
            yield* Ref.update(stateRef, (st) => {
              st.sidePane = stackToggle(st.sidePane)
              st.navPending = undefined
              return st
            })
            yield* requestRender
            return "stay" as const

          case "sideToggleSelect":
            yield* Ref.update(stateRef, (st) => {
              st.sidePane = sideToggleSelect(st.sidePane)
              st.navPending = undefined
              return st
            })
            yield* requestRender
            return "stay" as const

          case "buildSession":
            yield* doBuildSession
            return "stay" as const

          case "sideSelect": {
            const row = sideCurrentRow(s.sidePane)
            if (row !== undefined && row.collapsible) {
              // Enter on a segment header folds/unfolds it.
              yield* Ref.update(stateRef, (st) => {
                st.sidePane = sideToggleNode(st.sidePane)
                return st
              })
              yield* requestRender
              return "stay" as const
            }
            if (row !== undefined && row.messageIndex !== undefined) {
              const idx = row.messageIndex
              yield* Ref.update(stateRef, (st) => {
                const ok = st.scrollback.cursorToMessageIndex(idx)
                if (ok) {
                  st.focus = "conversation"
                  st.mode = "normal"
                } else {
                  st.scrollback.push({
                    kind: "info",
                    text: "message not in the loaded view (:resume to load full history)",
                  })
                }
                return st
              })
              yield* requestRender
              return "stay" as const
            }
            return "stay" as const
          }

          case "enterVisual":
            yield* Ref.update(stateRef, (st) => {
              st.scrollback.initCursor()
              st.scrollback.startVisual("char")
              st.mode = "visual"
              st.navPending = undefined
              return st
            })
            yield* requestRender
            return "stay" as const

          case "enterVisualLine":
            yield* Ref.update(stateRef, (st) => {
              st.scrollback.initCursor()
              st.scrollback.startVisual("line")
              st.mode = "visual"
              st.navPending = undefined
              return st
            })
            yield* requestRender
            return "stay" as const

          // Maximize / restore the focused read-only pane.
          case "toggleZoom":
            yield* Ref.update(stateRef, (st) => {
              if (st.zoomed) st.zoomed = false
              else if (st.focus === "conversation" || st.focus === "side") {
                st.zoomed = true
              }
              st.navPending = undefined
              return st
            })
            yield* requestRender
            return "stay" as const

          case "exitVisual":
            yield* Ref.update(stateRef, (st) => {
              st.scrollback.endVisual()
              st.mode = "normal"
              st.navPending = undefined
              return st
            })
            yield* requestRender
            return "stay" as const

          case "yank": {
            const text = s.scrollback.selectionText()
            const n = s.scrollback.selectionLineCount()
            yield* Effect.sync(() => osc52(text))
            yield* Ref.update(stateRef, (st) => {
              st.scrollback.endVisual()
              st.mode = "normal"
              st.navPending = undefined
              st.scrollback.push({
                kind: "info",
                text: `yanked ${n} line${n === 1 ? "" : "s"} to clipboard`,
              })
              return st
            })
            yield* requestRender
            return "stay" as const
          }

          // Open the `:` command line: focus the input, clear it, prime the
          // command palette with the full list.
          case "openCommand":
            yield* Ref.update(stateRef, (st) => {
              st.entry = "command"
              st.zoomed = false
              st.focus = "input"
              st.navPending = undefined
              st.input = emptyInput
              st.palette = computePalette(":")
              st.scrollback.endVisual()
              return st
            })
            yield* requestRender
            return "stay" as const

          // Open the `/` search line: focus the input, clear it, seed an empty
          // query (live highlight begins as you type). Remember which pane
          // opened it so Esc returns there; the conversation cursor stays put
          // (render shows a dim caret marking where Enter will land you).
          case "openSearch":
            yield* Ref.update(stateRef, (st) => {
              st.preSearchFocus = st.focus
              st.entry = "search"
              st.zoomed = false
              st.focus = "input"
              st.navPending = undefined
              st.input = emptyInput
              st.palette = hiddenPalette
              st.scrollback.search("")
              st.scrollback.endVisual()
              return st
            })
            yield* requestRender
            return "stay" as const

          // Edit the active command/search body via the input editor.
          case "entryEdit": {
            const r = applyKey(s.input, key, cols)
            yield* Ref.update(stateRef, (st) => {
              st.input = r.state
              const body = inputText(r.state)
              if (st.entry === "search") st.scrollback.search(body)
              else st.palette = computePalette(":" + body)
              return st
            })
            yield* requestRender
            return "stay" as const
          }

          // Enter: run the `:` command, or jump to the `/` match.
          case "entrySubmit": {
            const wasCommand = s.entry === "command"
            const body = inputText(s.input).trim()
            yield* Ref.update(stateRef, (st) => {
              st.entry = "message"
              st.input = emptyInput
              st.palette = hiddenPalette
              if (wasCommand) {
                // Back to the input, INSERT, ready for the next message.
                st.focus = "input"
                st.mode = "insert"
              } else {
                // Search: land *in the conversation* with the cursor on the
                // match (not stranded in the input). n/N then walk matches.
                st.scrollback.jumpToMatch()
                st.scrollback.initCursor()
                st.focus = "conversation"
                st.mode = "normal"
              }
              return st
            })
            if (wasCommand && body.length > 0) {
              const outcome = yield* handleSlash(":" + body)
              if (outcome === "exit") return "exit" as const
            }
            yield* requestRender
            return "stay" as const
          }

          // Esc: abandon the command/search line. A cancelled search clears its
          // highlight and returns to whichever pane opened it.
          case "entryCancel":
            yield* Ref.update(stateRef, (st) => {
              const wasSearch = st.entry === "search"
              st.entry = "message"
              st.input = emptyInput
              st.palette = hiddenPalette
              if (wasSearch) {
                st.scrollback.clearSearch()
                const back = st.preSearchFocus ?? "input"
                st.preSearchFocus = undefined
                st.focus = back
                st.mode = back === "input" ? "insert" : "normal"
                if (back === "conversation") st.scrollback.initCursor()
              } else {
                st.focus = "input"
                st.mode = "insert"
              }
              return st
            })
            yield* requestRender
            return "stay" as const

          case "match":
            yield* Ref.update(stateRef, (st) => {
              st.scrollback.nextMatch(intent.dir)
              return st
            })
            yield* requestRender
            return "stay" as const

          case "clearSearch":
            yield* Ref.update(stateRef, (st) => {
              st.scrollback.clearSearch()
              return st
            })
            yield* requestRender
            return "stay" as const

          case "none":
            yield* requestRender
            return "stay" as const
        }

        yield* requestRender
        return "stay" as const
      })

    const runtime = yield* Effect.runtime<FileSystem | Http | Shell | ConversationStore | LanguageModel.LanguageModel | SettingsStore | ModelRegistry | WebSearch | AuthStore>()

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
  FileSystem | Http | Shell | LanguageModel.LanguageModel | LlmInfo | ModelRegistry | ConversationStore | SettingsStore | WebSearch | AuthStore
> =>
  runTuiModeCore(input).pipe(
    Effect.provide(fileLoggerLayer(logFilePath())),
  )
