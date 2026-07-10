import { batch, createSignal } from "solid-js"
import type { Accessor } from "solid-js"
import { Option } from "effect"
import type { Effect } from "effect"
import type { AuthStore, FileSystem, ModelRole, SettingsStore, Shell, SpecDoc } from "@xandreed/engine"
import type { SmithEvent } from "../../domain/SmithEvent.js"
import type { SmithRunConfig } from "../../domain/SmithConfig.js"
import type { FloorState } from "../presentation/floor.js"
import { initialFloor, reduceFloor } from "../presentation/floor.js"
import type { RefineState } from "../presentation/refine.js"
import { initialRefine, reduceRefine, withUserLine } from "../presentation/refine.js"
import { costOf } from "../presentation/modelCatalog.js"
import { initialHistory, pushHistory } from "../presentation/history.js"
import type { HistoryState } from "../presentation/history.js"
import type { ConversationState } from "../presentation/conversation.js"
import {
  initialConversation,
  reduceConversationIn,
  withUserBlock,
} from "../presentation/conversation.js"
import type { WorkspaceView } from "../presentation/workspace.js"
import { emptyWorkspace } from "../presentation/workspace.js"
import type { LoginFlow } from "../presentation/loginFlow.js"
import type { SelectState } from "../presentation/selectBox.js"

export interface RolesReadout {
  readonly general: string
  readonly code: string
  readonly fast: string
}

/** idle = the persistent workspace dashboard (`bare smith`). */
export type SmithMode = "idle" | "refine" | "forge"

/** What a picker Enter means (routes `submitSelect` in the key handler). */
export type SelectPurpose =
  | { readonly tag: "model"; readonly role: ModelRole }
  | { readonly tag: "logout" }
  | { readonly tag: "resume" }
  /** The settings MENU (agy shape): rows are settings, Enter edits one. */
  | { readonly tag: "settings" }
  /** The fallback-model picker (`:settings` → fallback model). */
  | { readonly tag: "fallback-model" }
  /** A numeric preset picker for one keyed setting. */
  | { readonly tag: "setting-number"; readonly key: "maxAttempts" | "budgetMillis" }

/** ONE inline contextual surface at a time — select picker or the login
 *  flow; while open, the composer unmounts and keys route here. */
export type Overlay =
  | { readonly kind: "none" }
  | {
      readonly kind: "select"
      readonly purpose: SelectPurpose
      readonly sel: SelectState<Option.Option<string>>
    }
  | { readonly kind: "login"; readonly flow: LoginFlow }

/** An in-flight OAuth authorization the driver races (callback vs paste). */
export interface OAuthSession {
  readonly verifier: string
  /** Interrupt the waiter fiber + close the loopback server. */
  readonly stop: () => void
}

/** Everything a TUI action may reach through `ctx.run`. */
export type SmithUiServices = SettingsStore | AuthStore | FileSystem | Shell

export interface SmithStore {
  readonly floor: Accessor<FloorState>
  /** Fold one event into BOTH view models (Solid-batched by the pump). */
  readonly reduce: (event: SmithEvent) => void
  /** Fold a pump flush in ONE Solid batch — one frame per flush, however
   *  many coalesced deltas it carries. */
  readonly reduceBatch: (events: ReadonlyArray<SmithEvent>) => void
  readonly mode: Accessor<SmithMode>
  readonly setMode: (mode: SmithMode) => void
  readonly refine: Accessor<RefineState>
  /** The conversation pane's blocks — user/reasoning/assistant/tool. */
  readonly conversation: Accessor<ConversationState>
  readonly resetConversation: () => void
  readonly addUserLine: (text: string) => void
  readonly busy: Accessor<boolean>
  readonly setBusy: (busy: boolean) => void
  /** Epoch ms when the current turn/run started (0 = idle) — the elapsed
   *  readout that makes a SLOW model call visible instead of dead air. */
  readonly busySince: Accessor<number>
  /** Epoch ms of the last agent event — silence beyond a threshold renders
   *  the "model is slow" hint. */
  readonly lastEventAt: Accessor<number>
  /** The composer registers a text reader so the : palette can follow it. */
  readonly registerComposerRead: (read: () => string) => void
  readonly composerText: () => string
  /** The composer registers a text writer so Tab-completion can fill it. */
  readonly registerComposerSet: (set: (text: string) => void) => void
  readonly setComposer: (text: string) => void
  /** Messages typed while a turn is in flight — shown as pending, then
   *  drained into the NEXT turn all at once (never dropped, never deferred to
   *  session end). */
  readonly queued: Accessor<ReadonlyArray<string>>
  readonly enqueue: (text: string) => void
  /** Return every queued message and clear the queue in one step. */
  readonly drainQueue: () => ReadonlyArray<string>
  readonly spinner: Accessor<number>
  readonly tickSpinner: () => void
  /** The session's accumulated dollar spend, folded from each turn's usage
   *  at its priced model (unpriced turns add nothing). */
  readonly sessionCost: Accessor<number>
  /** ctrl+o: expand the newest tool block's result in-pane. */
  readonly toolExpand: Accessor<boolean>
  readonly toggleToolExpand: () => void
  /** The composer's ↑/↓ prompt ring (session-local, cap 50). */
  readonly history: Accessor<HistoryState>
  readonly setHistory: (state: HistoryState) => void
  /** One-line transient note (command feedback, interrupt notice). */
  readonly notice: Accessor<string>
  readonly setNotice: (text: string) => void
  /** The session fiber's exit code once it finished naturally. */
  readonly exitCode: Accessor<number | undefined>
  readonly setExitCode: (code: number) => void
  /** Epoch ms of the first Ctrl-C press (double-press quit window). */
  readonly ctrlCPendingAt: Accessor<number>
  readonly setCtrlCPendingAt: (at: number) => void
  readonly roles: Accessor<RolesReadout>
  readonly setRoles: (roles: RolesReadout) => void
  /** The inline contextual surface (picker / login) — ONE at a time. */
  readonly overlay: Accessor<Overlay>
  readonly setOverlay: (overlay: Overlay) => void
  readonly closeOverlay: () => void
  /** The in-flight OAuth authorization, if any (Esc/exit tears it down). */
  readonly oauth: Accessor<Option.Option<OAuthSession>>
  readonly setOauth: (session: Option.Option<OAuthSession>) => void
  /** The composer registers its clear so the Esc rule can reach it. */
  readonly registerComposerClear: (clear: () => void) => void
  readonly clearComposer: () => void
  /** The workspace dashboard (idle mode): specs · runs · lessons. */
  readonly workspace: Accessor<WorkspaceView>
  readonly setWorkspace: (view: WorkspaceView) => void
  /** Fresh floor for the NEXT forge run (a persistent session runs many). */
  readonly resetFloor: (task: string, maxAttempts: number) => void
  /** Fresh refine state for the NEXT idea. */
  readonly resetRefine: () => void
}

export interface SmithTuiContext {
  readonly store: SmithStore
  readonly runConfig: SmithRunConfig
  /** UI→Effect bridge (the captured Runtime); actions reach settings/auth/fs/shell. */
  readonly run: <A, E>(effect: Effect.Effect<A, E, SmithUiServices>) => Promise<A>
  /** Interrupt the running forge session (Esc). */
  readonly interrupt: () => void
  /** End the TUI with an exit code (`:quit`, Ctrl-C). */
  readonly exit: (code: number) => void
  /** Refine mode: one composer submission = one refiner turn. */
  readonly sendRefine?: (text: string) => void
  /** Refine mode: `:lock` — the human's approval. */
  readonly lock?: () => void
  /** `:forge [slug]` — forge the locked draft, or a named locked spec. */
  readonly forge?: (slug?: string) => void
  /** Workspace mode: plain composer text — starts/continues a refine. */
  readonly sendText?: (text: string) => void
  /** Workspace mode: `:new` — drop the current draft, back to the dashboard. */
  readonly newSpec?: () => void
  /** Workspace mode: `:resume <conversationId>` — load a previous session. */
  readonly resume?: (conversationId: string) => void
  /** `:branch` — fork the current session's trail into a new one. */
  readonly branch?: () => void
  /** `:ship` — branch/commit/push/PR the last ACCEPTED forge run's work. */
  readonly ship?: () => void
}

export const createSmithStore = (
  run: SmithRunConfig,
  roles: RolesReadout,
  mode: SmithMode = "forge",
): SmithStore => {
  const [floor, setFloor] = createSignal<FloorState>(
    initialFloor(run.task, run.maxAttempts),
  )
  const [refine, setRefine] = createSignal<RefineState>(initialRefine)
  const [conversation, setConversation] = createSignal<ConversationState>(initialConversation)
  const [modeSig, setModeSig] = createSignal<SmithMode>(mode)
  const [busy, setBusySig] = createSignal(false)
  const [spinner, setSpinner] = createSignal(0)
  const [notice, setNotice] = createSignal("")
  const [exitCode, setExitCodeSig] = createSignal<number | undefined>(undefined)
  const [workspace, setWorkspaceSig] = createSignal<WorkspaceView>(emptyWorkspace)
  const [rolesSig, setRolesSig] = createSignal<RolesReadout>(roles)
  const [overlay, setOverlaySig] = createSignal<Overlay>({ kind: "none" })
  const [oauth, setOauthSig] = createSignal<Option.Option<OAuthSession>>(Option.none())
  const composerClear = { current: () => {} }
  const composerRead = { current: (): string => "" }
  const composerSet = { current: (_text: string): void => {} }
  const [busySince, setBusySince] = createSignal(0)
  const [lastEventAt, setLastEventAt] = createSignal(0)
  const [ctrlCPendingAt, setCtrlCPendingAt] = createSignal(0)
  const [queued, setQueued] = createSignal<ReadonlyArray<string>>([])
  const [sessionCost, setSessionCost] = createSignal(0)
  const [toolExpand, setToolExpand] = createSignal(false)
  const [history, setHistory] = createSignal<HistoryState>(initialHistory)
  const apply = (event: SmithEvent): void => {
    setLastEventAt(Date.now())
    // The COST fold: every finished turn's usage priced at its model (the
    // router stamp; the active role when absent — e.g. scripted seams).
    if (event.type === "agent" && event.event.type === "assistant_message") {
      const turn = event.event
      const model =
        turn.model ?? (modeSig() === "forge" ? rolesSig().code : rolesSig().general)
      setSessionCost((total) => total + Option.getOrElse(costOf(model, turn.usage), () => 0))
    }
    // A refine failure must be IMPOSSIBLE to miss — the SpecPanel slot
    // alone hid provider errors from users watching the composer.
    if (event.type === "refine_error") {
      setNotice(`refine error: ${event.message.slice(0, 120)}`)
    }
    setFloor((state) => reduceFloor(state, event))
    setRefine((state) => reduceRefine(state, event))
    // The fold's mode picks the RIGHT advice on a bounded stop: forge
    // continues itself (gates → next attempt), refine waits for you.
    setConversation((state) =>
      reduceConversationIn(modeSig() === "forge" ? "forge" : "refine")(state, event),
    )
  }
  return {
    floor,
    reduce: (event) => batch(() => apply(event)),
    reduceBatch: (events) => batch(() => events.forEach(apply)),
    mode: modeSig,
    setMode: (next) => setModeSig(next),
    refine,
    conversation,
    resetConversation: () => setConversation(initialConversation),
    addUserLine: (text) => {
      setRefine((state) => withUserLine(state, text))
      setConversation((state) => withUserBlock(state, text))
      setHistory((state) => pushHistory(state, text))
    },
    busy,
    setBusy: (value) => {
      setBusySig(value)
      setBusySince(value ? Date.now() : 0)
      if (value) setLastEventAt(Date.now())
    },
    busySince,
    lastEventAt,
    registerComposerRead: (read) => {
      composerRead.current = read
    },
    composerText: () => composerRead.current(),
    registerComposerSet: (set) => {
      composerSet.current = set
    },
    setComposer: (text) => composerSet.current(text),
    queued,
    enqueue: (text) => setQueued((q) => [...q, text]),
    drainQueue: () => {
      const current = queued()
      setQueued([])
      return current
    },
    spinner,
    tickSpinner: () => setSpinner((n) => n + 1),
    sessionCost,
    toolExpand,
    toggleToolExpand: () => setToolExpand((on) => !on),
    history,
    setHistory,
    notice,
    setNotice,
    exitCode,
    setExitCode: (code) => setExitCodeSig(code),
    ctrlCPendingAt,
    setCtrlCPendingAt: (at) => setCtrlCPendingAt(at),
    roles: rolesSig,
    setRoles: (next) => setRolesSig(next),
    overlay,
    setOverlay: (next) => setOverlaySig(next),
    closeOverlay: () => setOverlaySig({ kind: "none" }),
    oauth,
    setOauth: (session) => setOauthSig(session),
    registerComposerClear: (clear) => {
      composerClear.current = clear
    },
    clearComposer: () => composerClear.current(),
    workspace,
    setWorkspace: (view) => setWorkspaceSig(view),
    resetFloor: (task, maxAttempts) => setFloor(initialFloor(task, maxAttempts)),
    resetRefine: () => setRefine(initialRefine),
  }
}

/** The locked-spec summary line the forge mode pins under the header. */
export const specChip = (doc: Option.Option<SpecDoc>): string =>
  Option.match(doc, {
    onNone: () => "",
    onSome: (d) =>
      `spec ${d.slug} (${d.status}) · ${d.acceptance.length} criteria · ${d.checks.length} checks`,
  })
