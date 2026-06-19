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
  readonly exit: () => void
  /** The loaded agent ROLES (`.efferent/agents/*.md`) — for `:agents` + `:spawn`. */
  readonly roles: ReadonlyArray<AgentDefinition>
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
  /** Import agent-definition files from GitHub into `.efferent/agents/`
   *  (`:agents add github:owner/repo[/path][@ref]`). Applies on next launch. */
  readonly importAgents: (spec: string) => void
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
