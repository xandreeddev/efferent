import { Schema } from "effect"
import { TokenUsage } from "../domain/token-usage.entity.js"
import { EntryId } from "../memory/memory-log.entity.js"
import type { LogBody } from "../memory/memory-log.entity.js"
import type { TurnEventName } from "../turn/turn-event.entity.js"
import { UserMessage } from "../turn/user-message.entity.js"
import { JsonObject } from "./session-log.entity.js"

/*
 * The session log's vocabulary. One log holds everything about a session;
 * the kinds say who wrote each event:
 * - the turn's lifecycle (`turn.started`, `turn.ended`), written by the
 *   sessions plugin;
 * - `turn.reply` and `memory.*`: the memory log, the entries every model
 *   request is rebuilt from (model-visible ⟺ logged);
 * - the turn's observable events (`step.*`, `tool.*`, `context.built`,
 *   `decision.recorded`, `completion.evaluated`), written from the bus;
 * - the inbox (`inbox.*`);
 * - anything else: a host's own records, under the host's own names.
 * `journalSchemaOf(kind)` (the paired functions file) gives the schema each
 * of the framework's kinds is stored with.
 */

/** Opens a turn: who asked, what they said, the host's command and the inbox items it claims. */
export const TurnStartedData = Schema.Struct({
  runId: Schema.String,
  /** The host's idempotency key: a second begin with it is the same turn. */
  key: Schema.String,
  origin: Schema.Literals(["user", "inbox"]),
  userMessage: UserMessage,
  /** The host's own input beside the message (an attachment, a reference), part of the key's fingerprint. */
  command: JsonObject,
  /** The inbox items this turn answers (an inbox turn only). */
  claimed: Schema.Array(Schema.String),
  /** The memory entry the message is to the model, and when memory took it. */
  entry: EntryId,
  at: Schema.Number,
  /**
   * The host's metadata for the turn (`BeginTurn.meta`), written only when
   * given: not part of the key's fingerprint and never shown to the model.
   */
  meta: Schema.optionalKey(JsonObject),
  /**
   * The earlier turn this one resumes (`BeginTurn.User.resumes`), written
   * only when given: part of the key's fingerprint.
   */
  resumes: Schema.optionalKey(Schema.Int),
})
export type TurnStartedData = typeof TurnStartedData.Type

export const TurnEndReason = Schema.Literals(["completed", "partial", "failed", "cancelled", "interrupted"])
export type TurnEndReason = typeof TurnEndReason.Type

/**
 * Closes a turn. Not model-visible: what later turns remember is `turn.reply`.
 * `failure.code` is the failing error's own code when it has one (a
 * `HarnessError`'s); otherwise one of the framework's codes, `turn.failed`
 * (a typed error without a code), `turn.defect`, `turn.interrupted` (an
 * interrupted turn or scope), `turn.unended` (a scope closed before its turn
 * ended) or `turn.lease` (a reaped turn), or a code the closer passes to
 * `writer.end` itself (plugin-tasks: `task.turn`, `task.deadline`; a host's
 * own). A cancel stores none.
 */
export const TurnEndedData = Schema.Struct({
  reason: TurnEndReason,
  failure: Schema.OptionFromNullOr(Schema.Struct({ code: Schema.String, message: Schema.String })),
})
export type TurnEndedData = typeof TurnEndedData.Type

/** An inbox item as delivered (`inbox.queued`): its stable id, who sent it and the text a turn shows the model. */
export const InboxQueuedData = Schema.Struct({
  id: Schema.String,
  source: JsonObject,
  content: Schema.String,
})
export type InboxQueuedData = typeof InboxQueuedData.Type

/** An inbox item given up on (`inbox.dropped`): as many turns took it and failed as the inbox allows. */
export const InboxDroppedData = Schema.Struct({
  id: Schema.String,
  reason: Schema.Literals(["attempts"]),
})
export type InboxDroppedData = typeof InboxDroppedData.Type

/**
 * One step's provider response as stored (`step.usage`): its step, model and
 * token usage. The rest of `assistant.message` is memory's `memory.message`.
 */
export const StepUsageData = Schema.Struct({
  step: Schema.Int,
  model: Schema.OptionFromNullOr(Schema.String),
  usage: TokenUsage,
})
export type StepUsageData = typeof StepUsageData.Type

/** The kind each memory entry is stored under. `TurnStarted` is the turn's own `turn.started`. */
export const MemoryKindOf = {
  SystemPrepared: "memory.system",
  TurnContext: "memory.section",
  StepContext: "memory.step",
  Message: "memory.message",
  ToolResult: "memory.tool-result",
  ToolDigest: "memory.digest",
  ToolsActivated: "memory.skills",
  Compaction: "memory.compaction",
  TurnEnded: "turn.reply",
} as const satisfies Record<Exclude<LogBody["_tag"], "TurnStarted">, string>

/** Every kind a memory session is rebuilt from. */
export const MEMORY_KINDS: ReadonlyArray<string> = ["turn.started", ...Object.values(MemoryKindOf)]

/** The turn's observable events stored from its bus (a host's records keep their own names). */
export const TURN_EVENT_KINDS: ReadonlyArray<string> = [
  "step.started", "step.ended", "step.usage", "tool.started", "tool.completed",
  "completion.evaluated", "context.built", "decision.recorded",
  "request.prepared",
]

/** Bus events not stored from the bus: memory or the session records them itself, and storing them again would be a second copy. */
export const RECORDED_ELSEWHERE: ReadonlySet<TurnEventName> = new Set<TurnEventName>(["turn.started", "turn.ended", "skills.activated"])

/** The inbox and the session's own records. */
export const SESSION_KINDS: ReadonlyArray<string> = ["turn.ended", "inbox.queued", "inbox.dropped"]

/**
 * Kinds only Efferent writes: a host record under one of these names is refused.
 * `request.prepared` holds each request's full system text and tool
 * declarations (and step context in "system" mode), next to the memory
 * events: a host that redacts memory, or exports or streams session events,
 * handles it the same way.
 */
export const RESERVED_KINDS: ReadonlyArray<string> = [...MEMORY_KINDS, ...TURN_EVENT_KINDS, ...SESSION_KINDS]
