import { Schema } from "effect"
import { RunId, RunKey } from "../domain/run.entity.js"
import { TokenUsage } from "../domain/token-usage.entity.js"
import { FinishReason, TurnEnding, TurnOrigin } from "../domain/turn-vocabulary.entity.js"
import { EntryId } from "../memory/memory-log.entity.js"
import type { LogBody } from "../memory/memory-log.entity.js"
import { TURN_EVENT_NAMES } from "../turn/turn-event.entity.js"
import type { TurnEventName } from "../turn/turn-event.entity.js"
import { UserMessage } from "../turn/user-message.entity.js"
import { JsonObject } from "./session-log.entity.js"
import { TaskRef } from "./tasks.entity.js"
import { InputDelivery } from "./sessions.entity.js"

/**
 * An inbox item's id as stored: `InboxItemId`'s brand without its checks,
 * so every stored id reads back as it was written.
 */
const StoredInboxItemId = Schema.String.pipe(Schema.brand("InboxItemId"))

/*
 * The session log's vocabulary. One log holds everything about a session;
 * the kinds say who wrote each event:
 * - the turn's lifecycle (`turn.started`, `turn.ended`), written by the
 *   sessions plugin;
 * - `turn.reply` and `memory.*`: the memory log, the entries every model
 *   request is rebuilt from (model-visible ⟺ logged);
 * - the turn's observable events (`step.*`, `tool.*`, `context.built`,
 *   `decision.recorded`, `completion.evaluated`, `stream.fallback`),
 *   written from the bus;
 * - the inbox (`inbox.*`);
 * - anything else: a host's own records, under the host's own names.
 * `journalSchemaOf(kind)` (the paired functions file) gives the schema each
 * of the framework's kinds is stored with.
 */

/**
 * Opens a turn: who asked, what they said, the host's command, the inbox
 * items it claims and the task it runs.
 *
 * @public
 */
export const TurnStartedData = Schema.Struct({
  runId: RunId,
  /** The host's idempotency key: a second begin with it is the same turn. */
  key: Schema.String,
  origin: TurnOrigin,
  userMessage: UserMessage,
  /** The host's own input beside the message (an attachment, a reference), part of the key's fingerprint. */
  command: JsonObject,
  /** The inbox items this turn answers (an inbox turn only). */
  claimed: Schema.Array(StoredInboxItemId),
  /** The queued input this user turn answers; absent in older records and direct user turns. */
  input: Schema.optionalKey(StoredInboxItemId),
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
  /**
   * The task a task's turn runs (`BeginTurn.Task`; origin `task`), written
   * only on such a turn: part of the key's fingerprint. A task's turn stored
   * before tasks had an origin of their own reads as a user's, its task id
   * in `command.task`.
   */
  task: Schema.optionalKey(TaskRef),
})
export type TurnStartedData = typeof TurnStartedData.Type

/**
 * Closes a turn: the `TurnEnding` its closer recorded (see `TurnFailure` for
 * the codes a failure stores). Not model-visible: what later turns remember
 * is `turn.reply`. A cancel stores no failure.
 *
 * @public
 */
export const TurnEndedData = TurnEnding
export type TurnEndedData = TurnEnding

/** An inbox item as delivered (`inbox.queued`): a notice's content or one queued user message, its stable id and source. */
export const InboxQueuedData = Schema.Struct({
  id: StoredInboxItemId,
  source: JsonObject,
  content: Schema.String,
  /** Queued user input; legacy notices have only content. Input writes content empty so its bytes occur once. */
  input: Schema.optionalKey(Schema.Struct({ userMessage: UserMessage, delivery: InputDelivery })),
})
export type InboxQueuedData = typeof InboxQueuedData.Type

/** An inbox item given up on (`inbox.dropped`): as many turns took it and failed as the inbox allows. */
export const InboxDroppedData = Schema.Struct({
  id: StoredInboxItemId,
  reason: Schema.Literals(["attempts"]),
})
export type InboxDroppedData = typeof InboxDroppedData.Type

/** One queued steer acknowledged with its durable memory.message, in the same turn commit. @public */
export const InboxTakenData = Schema.Struct({ id: StoredInboxItemId, entry: EntryId })
export type InboxTakenData = typeof InboxTakenData.Type

/**
 * One step's provider response as stored (`step.usage`): its step, run (a
 * record written before runs were counted reads 0), model, token usage and
 * why it ended (absent in records stored before format 2). The rest of
 * `assistant.message` is memory's `memory.message`.
 *
 * @public
 */
export const StepUsageData = Schema.Struct({
  step: Schema.Int,
  run: RunKey,
  model: Schema.OptionFromNullOr(Schema.String),
  usage: TokenUsage,
  finishReason: Schema.optionalKey(FinishReason),
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
  ToolPresentation: "memory.tool-presentation",
} as const satisfies Record<Exclude<LogBody["_tag"], "TurnStarted">, string>

/** Every kind a memory session is rebuilt from. */
export const MEMORY_KINDS: ReadonlyArray<string> = ["turn.started", ...Object.values(MemoryKindOf)]

/**
 * The turn's observable events stored from its bus (a host's records keep
 * their own names).
 *
 * @public
 */
export const TURN_EVENT_KINDS: ReadonlyArray<string> = [
  "step.started", "step.ended", "step.usage", "tool.started", "tool.refused", "tool.completed",
  "completion.evaluated", "context.built", "decision.recorded", "stream.fallback",
  "request.prepared",
]

/** Bus events not stored from the bus: memory or the session records them itself, and storing them again would be a second copy. */
export const RECORDED_ELSEWHERE: ReadonlySet<TurnEventName> = new Set<TurnEventName>(["turn.started", "turn.ended", "skills.activated", "model.called"])

/**
 * The inbox and the session's own records.
 *
 * @public
 */
export const SESSION_KINDS: ReadonlyArray<string> = ["turn.ended", "inbox.queued", "inbox.dropped", "inbox.taken"]

/**
 * Every kind the framework writes to a session's journal: memory's, the
 * bus events it stores, and the session's own. `journalSchemaOf(kind)` has
 * the schema of each. `request.prepared` holds each request's full system
 * text and tool declarations (and step context in "system" mode), next to
 * the memory events: a host that redacts memory, or exports or streams
 * session events, handles it the same way.
 */
export const JOURNAL_KINDS: ReadonlyArray<string> = [...MEMORY_KINDS, ...TURN_EVENT_KINDS, ...SESSION_KINDS, "model.called"]

/**
 * Names only Efferent uses: a host event or a host record under one of
 * these is refused. They are the kinds the framework writes
 * (`JOURNAL_KINDS`) and every bus event's name (`TURN_EVENT_NAMES`), the
 * ones never stored under their own name included (`assistant.message`,
 * `assistant.delta`, `tool.progress`, `skills.activated`, `host`), so a host
 * event never reads as one of the framework's.
 */
export const RESERVED_KINDS: ReadonlyArray<string> = [...JOURNAL_KINDS, ...TURN_EVENT_NAMES.filter((name) => !JOURNAL_KINDS.includes(name))]
