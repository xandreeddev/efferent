import { Context, type Effect, Schema, type Stream } from "effect"
import { AgentEvent } from "../entities/AgentEvent.js"
import { AgentMessage, ConversationId } from "../entities/Conversation.js"
import { ContextNodeId } from "../entities/AgentContext.js"
import { Directive } from "../entities/Directive.js"
import { Settings } from "../entities/Settings.js"
import { AgentPhase } from "../entities/AgentPhase.js"
import { ApprovalDecision, ApprovalRequest } from "./Approval.js"

/**
 * The **Workspace** port — the seam the daemon split is built on. It is the
 * complete command/query surface a frontend needs ("one workspace · many
 * sessions · one seat"), expressed once, transport-agnostically: the agent, the
 * port, and every frontend depend ONLY on this interface plus the serializable
 * Schemas below — never on HTTP. Two implementations satisfy it:
 *
 *   - **in-process** (`efferent` `workspace/inProcess.ts`) — wraps the
 *     real `buildScopeRuntime` + bus + fleet + stores; the daemon hosts it; the
 *     sole authoritative owner of live state.
 *   - **remote** (`workspace/remote.ts`) — implements the same interface by
 *     calling a *transport client*; its `subscribe` stream feeds the TUI's
 *     existing event reducer verbatim.
 *
 * A transport (HTTP/SSE first) is one swappable last-layer adapter pair mapping
 * these Schemas onto a wire; nothing here knows it exists.
 *
 * The contract mirrors `TuiContext` — the surface the TUI already drove through.
 * `copySelection`/`exit`/`run`/`roles`/`tools` stay CLIENT-only (presentation /
 * process concerns), so they are not on the port.
 */

/**
 * A session's identity. A root session is keyed by its `ConversationId` (already
 * the bus mailbox key); an agent session by its `ContextNodeId`. Both are UUIDs,
 * so `SessionId` is one UUID brand and the `kind` field disambiguates — a plain
 * UUID string is what crosses the wire.
 */
export const SessionId = Schema.UUID.pipe(Schema.brand("SessionId"))
export type SessionId = typeof SessionId.Type

/** A `ConversationId` IS a valid `SessionId` (both UUID brands; runtime value identical). */
export const conversationSessionId = (id: ConversationId): SessionId => id as unknown as SessionId
/** A `ContextNodeId` IS a valid `SessionId`. */
export const nodeSessionId = (id: ContextNodeId): SessionId => id as unknown as SessionId
/** Read a `SessionId` back as a `ConversationId` (caller knows `kind === "root"`). */
export const sessionConversationId = (id: SessionId): ConversationId =>
  id as unknown as ConversationId
/** Read a `SessionId` back as a `ContextNodeId` (caller knows `kind === "agent"`). */
export const sessionNodeId = (id: SessionId): ContextNodeId => id as unknown as ContextNodeId

export const SessionKind = Schema.Literal("root", "agent")
export type SessionKind = typeof SessionKind.Type

/**
 * A session's lifecycle status. `running` while a turn/run is in flight; `idle`
 * for a root with no turn running; `ok`/`error`/`interrupted` are terminal for
 * an agent node (root sessions are never terminal — they idle).
 */
export const SessionStatus = Schema.Literal(
  "running",
  "ok",
  "error",
  "idle",
  "interrupted",
)
export type SessionStatus = typeof SessionStatus.Type

export const SessionSummary = Schema.Struct({
  id: SessionId,
  kind: SessionKind,
  /** Display title (conversation title, or the spawner's name for an agent). */
  title: Schema.optional(Schema.String),
  /** The folder the session is scoped to (workspace cwd for a root). */
  folder: Schema.String,
  status: SessionStatus,
  /** The enclosing session, or null for a root / top-level agent. */
  parentId: Schema.NullOr(SessionId),
  /** A fleet root's pinned chat model (`"<provider>:<modelId>"`), if set — the
   *  dashboard shows it per fleet (like a deployment's image). Root-only. */
  model: Schema.optional(Schema.String),
})
export type SessionSummary = typeof SessionSummary.Type

/** One event on a session's stream, tagged with a monotonic per-session
 *  sequence number for reconnect/replay. */
export const SeqEvent = Schema.Struct({
  seq: Schema.Number,
  event: AgentEvent,
})
export type SeqEvent = typeof SeqEvent.Type

/**
 * A session's full state for (re)attach. `log` is the **persisted messages** —
 * the client rebuilds presentation blocks by replaying them through its own
 * reducer (`projectHistory`/`makeEventReducer`), so presentation stays 100%
 * client-side and the daemon ships only `AgentEvent`s + messages, never UI
 * blocks. `cursor` is the last `seq` already reflected in `log`/state, so the
 * client streams from there.
 */
export const SessionState = Schema.Struct({
  session: SessionSummary,
  log: Schema.Array(AgentMessage),
  /**
   * The **absolute position** of `log[0]` in the conversation (0 when nothing
   * is folded; `latestCheckpoint.messagePosition + 1` after a handoff narrows
   * the window). Positions are contiguous + immutable, so the client derives
   * each message's absolute position as `logBaseOffset + index` and keys its
   * rail blocks on it — the same key the live event stream carries, so a
   * replayed/re-projected message reconciles instead of duplicating. `optional`
   * so a stale daemon still decodes (client reads `?? 0`).
   */
  logBaseOffset: Schema.optional(Schema.Number),
  busy: Schema.Boolean,
  /**
   * The daemon's **authoritative** lifecycle phase for this session, derived by
   * folding every published root event through `reducePhase`. The client
   * reconciles its own `agentState` machine against this on (re)attach + resync,
   * so a client that joins mid-turn shows `thinking` and an idle daemon clears a
   * stale `thinking` spinner. `optional` so a stale daemon that predates the
   * field still decodes — the client then falls back to `busy ? "thinking" :
   * "idle"`.
   */
  phase: Schema.optional(AgentPhase),
  /**
   * Messages typed while this session was busy, awaiting their turn — the
   * pending `▸` list the client shows above the input (agy-style queue). The
   * daemon drains it one-per-turn as the current turn finishes. `optional` so a
   * stale daemon that predates the field still decodes (client reads `?? []`).
   */
  queue: Schema.optional(Schema.Array(Schema.String)),
  pendingApproval: Schema.NullOr(ApprovalRequest),
  cursor: Schema.Number,
})
export type SessionState = typeof SessionState.Type

export const WorkspaceSnapshot = Schema.Struct({
  sessions: Schema.Array(SessionSummary),
  directive: Schema.NullOr(Directive),
  activeSessionId: Schema.NullOr(SessionId),
})
export type WorkspaceSnapshot = typeof WorkspaceSnapshot.Type

export const SpawnRequest = Schema.Struct({
  /** A named agent role; absent ⇒ a generic scoped sub-agent. */
  agent: Schema.optional(Schema.String),
  folder: Schema.String,
  task: Schema.String,
  /** Display title (2–5 words); defaults from the task when absent. */
  title: Schema.optional(Schema.String),
})
export type SpawnRequest = typeof SpawnRequest.Type

export const ImportResult = Schema.Struct({
  written: Schema.Array(Schema.String),
  skipped: Schema.Array(Schema.String),
})
export type ImportResult = typeof ImportResult.Type

/**
 * Create a new **fleet** — a fresh root/coordinator conversation working a task.
 * The k8s-deployment unit: `model` pins the fleet's chat model (defaults to the
 * global `settings.model`), so changing the global default never touches a
 * running fleet. `task` (when given) starts the first turn immediately.
 */
export const CreateFleetRequest = Schema.Struct({
  title: Schema.optional(Schema.String),
  folder: Schema.String,
  task: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
})
export type CreateFleetRequest = typeof CreateFleetRequest.Type

/** One inter-agent message for the dashboard's "messages flying" view —
 *  a blackboard post, a direct inbox message, or a completion note. */
export const FleetMessage = Schema.Struct({
  from: Schema.String,
  content: Schema.String,
  at: Schema.Number,
})
export type FleetMessage = typeof FleetMessage.Type

/** A partial settings update — the dashboard's "config defaults" panel posts
 *  this; the daemon merges it into its live Settings + persists it (the daemon
 *  owns its config, no file-editing behind its back). `model` here sets the
 *  DEFAULT new fleets inherit — never a running fleet (use `setFleetModel`). */
export const SettingsPatch = Schema.partial(Settings)
export type SettingsPatch = typeof SettingsPatch.Type

/** Per-role token + cost totals (cumulative since the daemon started). */
export const RoleTokens = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cache: Schema.Number,
  costUsd: Schema.Number,
})
export type RoleTokens = typeof RoleTokens.Type

/**
 * Live workspace metrics for the dashboard — self-contained (read from the
 * process-global Effect metric registry + the bus, no Grafana). Cumulative
 * since the daemon started, except `messagesPerMin` (a 60s rate).
 */
export const WorkspaceMetrics = Schema.Struct({
  tokensByRole: Schema.Record({ key: Schema.String, value: RoleTokens }),
  costUsdTotal: Schema.Number,
  agentsRunning: Schema.Number,
  agentsDone: Schema.Number,
  fleets: Schema.Number,
  turns: Schema.Number,
  toolCallsOk: Schema.Number,
  toolCallsFail: Schema.Number,
  errors: Schema.Number,
  approvalsPrompted: Schema.Number,
  messagesPerMin: Schema.Number,
  uptimeMs: Schema.Number,
})
export type WorkspaceMetrics = typeof WorkspaceMetrics.Type

/**
 * One tagged error for the whole port — a `Schema.TaggedError` so it crosses a
 * transport as a JSON body and decodes back to a typed failure on the client.
 */
export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()(
  "WorkspaceError",
  { message: Schema.String },
) {}

export class Workspace extends Context.Tag("@xandreed/sdk-core/Workspace")<
  Workspace,
  {
    /** Sessions + directive + which session has the seat — one read for attach. */
    readonly snapshot: () => Effect.Effect<WorkspaceSnapshot, WorkspaceError>
    readonly listSessions: () => Effect.Effect<
      ReadonlyArray<SessionSummary>,
      WorkspaceError
    >
    /** Full state for (re)attach: persisted log + live status + pending approval. */
    readonly getState: (
      id: SessionId,
      since?: number,
    ) => Effect.Effect<SessionState, WorkspaceError>
    /** Send a prompt to a session (root or agent); starts/continues a turn. */
    readonly send: (
      id: SessionId,
      prompt: string,
    ) => Effect.Effect<void, WorkspaceError>
    /** Interrupt a session: a fleet root cancels its whole subtree; an agent
     *  cancels just that node. */
    readonly interrupt: (id: SessionId) => Effect.Effect<void, WorkspaceError>
    /** Drop a session's pending (queued-while-busy) messages without touching the
     *  running turn — the client pulls them back into its composer to edit. */
    readonly clearQueue: (id: SessionId) => Effect.Effect<void, WorkspaceError>
    readonly spawn: (
      req: SpawnRequest,
    ) => Effect.Effect<SessionId, WorkspaceError>
    /** Create a new fleet (root coordinator) — the dashboard "spawn fleet" + the
     *  coder "new fleet". Returns the fleet's root `SessionId`. */
    readonly createFleet: (
      req: CreateFleetRequest,
    ) => Effect.Effect<SessionId, WorkspaceError>
    /** Pin (or change) a fleet's chat model — the per-fleet config that shields a
     *  running fleet from a global-default change. */
    readonly setFleetModel: (
      id: SessionId,
      model: string,
    ) => Effect.Effect<void, WorkspaceError>
    readonly stop: (id: SessionId) => Effect.Effect<void, WorkspaceError>
    /** Live event stream for a session; replays from `since` then tails. */
    readonly subscribe: (
      id: SessionId,
      since?: number,
    ) => Stream.Stream<SeqEvent, WorkspaceError>
    /** Answer a session's pending bash-approval request. */
    readonly approve: (
      id: SessionId,
      decision: ApprovalDecision,
    ) => Effect.Effect<void, WorkspaceError>
    /** Live in-daemon metrics for the control dashboard (no Grafana needed). */
    readonly metrics: () => Effect.Effect<WorkspaceMetrics, WorkspaceError>
    /** Recent inter-agent messages (the blackboard tail) — seeds the dashboard's
     *  "messages flying" view before it tails the `board_note` event stream. */
    readonly messages: (
      limit?: number,
    ) => Effect.Effect<ReadonlyArray<FleetMessage>, WorkspaceError>
    /** The daemon's current settings (the dashboard's config view reads this). */
    readonly getSettings: () => Effect.Effect<Settings, WorkspaceError>
    /** Merge a partial settings update into the daemon's live config + persist
     *  it — effective on the next turn, no restart (the daemon is the source of
     *  truth for its config). */
    readonly updateSettings: (
      patch: SettingsPatch,
    ) => Effect.Effect<Settings, WorkspaceError>
    readonly getDirective: () => Effect.Effect<
      Directive | undefined,
      WorkspaceError
    >
    readonly setDirective: (
      d: Directive | undefined,
    ) => Effect.Effect<void, WorkspaceError>
    readonly importAgents: (
      spec: string,
    ) => Effect.Effect<ImportResult, WorkspaceError>
    readonly importTools: (
      spec: string,
    ) => Effect.Effect<ImportResult, WorkspaceError>
  }
>() {}
