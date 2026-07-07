import type { Effect } from "effect"
import type {
  AgentDefinition,
  ApprovalDecision,
  AuthFlow,
  AuthStore,
  ContextTreeStore,
  ConversationStore,
  FileSystem,
  Http,
  LlmInfo,
  ModelRegistry,
  SettingsStore,
  Shell,
  StoreSwitch,
  UtilityLlm,
  WebSearch,
} from "@xandreed/sdk-core"
import type { LanguageModel } from "@effect/ai"
import type { ToolDefinition } from "@xandreed/sdk-core"
import type { TuiStore } from "./state/store.js"

/**
 * Every domain service the captured Effect runtime provides — the R-channel of
 * the UI⇄Effect bridge (the same one the old TUI captured at `tui.ts:3558`).
 * Domain state lives behind these services (Effect side); UI state lives in the
 * signal store (Solid side). The only crossings are `ctx.run` (UI→Effect, here)
 * and the event pump (Effect→signals, `events/eventPump.ts`).
 */
export type AppServices =
  | FileSystem
  | Http
  | Shell
  | ConversationStore
  | ContextTreeStore
  | StoreSwitch
  | LanguageModel.LanguageModel
  | SettingsStore
  | ModelRegistry
  | UtilityLlm
  | WebSearch
  | AuthStore
  | AuthFlow
  | LlmInfo

/**
 * The single handle the whole view tree consumes. `run` bridges UI→Effect (any
 * program requiring a subset of `AppServices`); `submit`/`interrupt`/`exit` are
 * lifted high-level actions; `store` is the reactive UI state. Constructed once
 * in `runtime.ts` and threaded through props — never a global.
 */
export interface TuiContext {
  readonly store: TuiStore
  readonly run: <A, E>(program: Effect.Effect<A, E, any>) => Promise<A>
  readonly submit: (text: string) => void
  readonly interrupt: () => void
  /**
   * Start a fresh conversation (`:clear`) — the rail is already reset by the
   * caller; this owns the conversation identity. In-process mints a new local
   * `ConversationId`; the remote/master bin creates a NEW daemon fleet and
   * re-points the client (subscribe/send/state) to it, so the next message and
   * any resync go to the new conversation rather than resurrecting the old one.
   */
  readonly newConversation: () => void
  /**
   * Drop every pending (queued) message — the queue the `▸` list shows. The
   * in-process bin clears its own run-handle queue; the remote bin asks the
   * daemon to forget its authoritative queue (and clears the local mirror). Used
   * by the agy two-stage Esc: first Esc pulls pending messages back into the
   * composer (this clears them so they don't ALSO run), second Esc interrupts.
   */
  readonly clearQueue: () => void
  readonly exit: () => void
  /**
   * Which bin's chrome this TUI wears — `"master"` (the `efferent` assistant:
   * full chrome + the cross-session fleet tree) or `"code"` (the focused coder:
   * a `code` wordmark + the fleet tree scoped to the one working session).
   * Static for the process's life; the view reads it for the header wordmark
   * and tree scope (see `TuiModeInput.variant`).
   */
  readonly variant: "master" | "code"
  /** The loaded agent ROLES (`.efferent/agents/*.md`) — for `:agents` + `:spawn`. */
  readonly roles: ReadonlyArray<AgentDefinition>
  /** The loaded declarative tools (`.efferent/tools/*.md`) — for `:tools`. */
  readonly tools: ReadonlyArray<ToolDefinition>
  /**
   * Fire a named agent role detached from the current turn (`:spawn`) — runs
   * alongside the conversation, shows in `:tree`/activity, cancellable via
   * `:stop <id>`. Fire-and-forget (the action owns its own errors).
   */
  readonly spawnAgent: (agent: string, folder: string, task: string) => void
  /** Interrupt a running fired agent by its fleet index (`:stop <id>`). */
  readonly stopAgent: (id: number) => void
  /** Currently-running fired agents, for `:stop`/status display. */
  readonly listFleet: () => ReadonlyArray<{
    readonly id: number
    readonly title: string
    readonly folder: string
  }>
  /** Every agent the bus knows is running right now — the WHOLE live fleet,
   *  including model-spawned background agents (not just `:spawn`-fired ones).
   *  For the `:fleet` cockpit. Excludes the root session's own mailbox key. */
  readonly liveAgents: () => ReadonlyArray<{ readonly nodeId: string; readonly label: string }>
  /** Import agent-definition files from GitHub into `.efferent/agents/`
   *  (`:agents add github:owner/repo[/path][@ref]`). Applies on next launch. */
  readonly importAgents: (spec: string) => void
  /** Import declarative tool files from GitHub into `.efferent/tools/`
   *  (`:tools add github:owner/repo[/path][@ref]`). Applies on next launch. */
  readonly importTools: (spec: string) => void
  /** The session's standing goal (Phase 4), injected into every turn's prompt. */
  /**
   * Copy the current OpenTUI mouse selection to the system clipboard (OSC 52).
   * Returns false when nothing is selected. Bound to `y` on the read-only panes
   * — the non-vim copy path (OpenTUI owns mouse drag-select; this yanks it).
   */
  readonly copySelection: () => boolean
  /**
   * Answer the pending bash-approval request (the agent fiber is suspended on
   * it). Called by the approval modal's key handler; a no-op when nothing is
   * pending. The UI→Effect counterpart of the `Approval` port's ask.
   */
  readonly resolveApproval: (decision: ApprovalDecision) => void
}
