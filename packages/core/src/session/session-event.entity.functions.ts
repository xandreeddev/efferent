import { Effect, Option, Schema, Struct } from "effect"
import { sumUsage } from "../domain/token-usage.entity.functions.js"
import type { TokenUsage } from "../domain/token-usage.entity.js"
import { canonicalJson } from "../memory/memory-log.entity.functions.js"
import { EntryId, LogBody, LogEntry } from "../memory/memory-log.entity.js"
import { ModelRequestHeader } from "../turn/model-request.entity.js"
import { ContextBuiltEvent, ToolCompletedEvent, TransientTurnEvents, TurnEvent } from "../turn/turn-event.entity.js"
import type { TurnEvent as TurnEventType } from "../turn/turn-event.entity.js"
import {
  InboxDroppedData,
  InboxQueuedData,
  MemoryKindOf,
  RECORDED_ELSEWHERE,
  StepUsageData,
  TURN_EVENT_KINDS,
  TurnEndedData,
  TurnStartedData,
} from "./session-event.entity.js"
import type { TurnEndedData as TurnEnded, TurnStartedData as TurnStarted } from "./session-event.entity.js"
import type { JsonObject, SessionDraft, SessionLogEvent } from "./session-log.entity.js"

const encodeEntry = Schema.encodeEffect(LogEntry)
const decodeEntry = Schema.decodeUnknownEffect(LogEntry)
const encodeTurnEvent = Schema.encodeSync(TurnEvent)
const tagOfKind: ReadonlyMap<string, string> = new Map(Object.entries(MemoryKindOf).map(([tag, kind]) => [kind, tag]))

/** Stored JSON read back with sorted keys: every store gives the same bytes, as the canonical log did. */
const canonical = (data: JsonObject): Record<string, unknown> => JSON.parse(canonicalJson(data)) as Record<string, unknown>

const turnOf = (event: SessionLogEvent): number => Option.getOrElse(event.turn, () => 0)

/**
 * One memory entry → the draft it is stored as: its own kind, the entry's
 * id, run, step and time, and the body. TurnStarted has none: the turn's
 * `turn.started` (written when the turn begins) is that entry.
 */
export const draftOfEntry = (entry: LogEntry): Effect.Effect<Option.Option<SessionDraft>, Schema.SchemaError> =>
  entry.body._tag === "TurnStarted" ? Effect.succeed(Option.none()) : encodeEntry(entry).pipe(Effect.map((encoded) => {
    const { _tag, ...body } = encoded.body
    const kind = MemoryKindOf[_tag as keyof typeof MemoryKindOf]
    return Option.some({
      kind,
      turn: Option.some(entry.turn),
      data: { entry: encoded.id, runId: encoded.runId, step: encoded.step, at: encoded.at, body },
    })
  }))

export const draftsOfEntries = (entries: ReadonlyArray<LogEntry>): Effect.Effect<ReadonlyArray<SessionDraft>, Schema.SchemaError> =>
  Effect.forEach(entries, draftOfEntry).pipe(Effect.map((drafts) => drafts.flatMap(Option.toArray)))

/** The draft that opens a turn. */
export const turnStartedDraft = (turn: number, data: TurnStarted): Effect.Effect<SessionDraft, Schema.SchemaError> =>
  Schema.encodeEffect(TurnStartedData)(data).pipe(Effect.map((encoded) => ({ kind: "turn.started", turn: Option.some(turn), data: { ...encoded } })))

/** The draft that closes a turn. */
export const turnEndedDraft = (turn: number, data: TurnEnded): Effect.Effect<SessionDraft, Schema.SchemaError> =>
  Schema.encodeEffect(TurnEndedData)(data).pipe(Effect.map((encoded) => ({ kind: "turn.ended", turn: Option.some(turn), data: { ...encoded } })))

/** A stored `turn.started`, decoded. */
export const turnStartedOf = (event: SessionLogEvent): Effect.Effect<TurnStarted, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(TurnStartedData)(canonical(event.data))

/** A stored `turn.ended`, decoded. */
export const turnEndedOf = (event: SessionLogEvent): Effect.Effect<TurnEnded, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(TurnEndedData)(canonical(event.data))

/**
 * One stored event → the memory entry it is, if it is one. A `turn.started`
 * is decoded once: its user message, attachments included, is the entry's.
 */
export const entryOfEvent = (event: SessionLogEvent): Effect.Effect<Option.Option<LogEntry>, Schema.SchemaError> => {
  if (event.kind === "turn.started") {
    return turnStartedOf(event).pipe(Effect.map((started): Option.Option<LogEntry> => Option.some({
      id: started.entry, runId: started.runId, turn: turnOf(event), step: 0, at: started.at,
      body: { _tag: "TurnStarted", userMessage: started.userMessage },
    })))
  }
  const tag = tagOfKind.get(event.kind)
  if (tag === undefined) return Effect.succeed(Option.none())
  const data = canonical(event.data)
  const body = typeof data.body === "object" && data.body !== null ? data.body : {}
  return decodeEntry({ id: data.entry, runId: data.runId, turn: turnOf(event), step: data.step, at: data.at, body: { ...body, _tag: tag } })
    .pipe(Effect.map(Option.some))
}

/** The memory log held in a session's events, in log order. */
export const entriesOfEvents = (events: ReadonlyArray<SessionLogEvent>): Effect.Effect<ReadonlyArray<LogEntry>, Schema.SchemaError> =>
  Effect.forEach(events, entryOfEvent).pipe(Effect.map((entries) => entries.flatMap(Option.toArray)))

/** A completed tool's input and result are in the memory log (the call and its `memory.tool-result`). */
const OMITTED_FROM_TOOL_COMPLETED = ["result", "encoded", "input"] as const

const withoutPayload = (data: Record<string, unknown>): JsonObject =>
  Object.fromEntries(Object.entries(data).filter(([key]) => !(OMITTED_FROM_TOOL_COMPLETED as ReadonlyArray<string>).includes(key)))

const encodeStepUsage = Schema.encodeSync(StepUsageData)
const decodeStepUsage = Schema.decodeUnknownEffect(StepUsageData)

/**
 * Turn `turn`'s usage from a session's stored events: its `step.usage`
 * records summed, which is what the turn's `assistant.message` events
 * carried (`TurnResult.usage`, `turn.ended.usage`). A record written before
 * 0.14.0 reads 0 cache-write and reasoning tokens.
 */
export const turnUsageOf = (events: ReadonlyArray<SessionLogEvent>, turn: number): Effect.Effect<TokenUsage, Schema.SchemaError> =>
  Effect.forEach(
    events.filter((event) => event.kind === "step.usage" && Option.contains(event.turn, turn)),
    (event) => decodeStepUsage(canonical(event.data)),
  ).pipe(Effect.map((records) => sumUsage(records.map((record) => record.usage))))

/**
 * The stored form of one bus event of turn `turn`: its name and encoded
 * payload. Transient events are not stored; a host's event keeps its name
 * and data; an assistant message is stored only as the step's model and
 * usage (its content is memory's `memory.message`).
 */
export const draftOfTurnEvent = (turn: number, event: TurnEventType): Option.Option<SessionDraft> => {
  if (TransientTurnEvents.includes(event._tag) || RECORDED_ELSEWHERE.has(event._tag)) return Option.none()
  if (event._tag === "host") return Option.some({ kind: event.name, turn: Option.some(turn), data: event.data })
  if (event._tag === "assistant.message") {
    return Option.some({ kind: "step.usage", turn: Option.some(turn), data: { ...encodeStepUsage({ step: event.step, model: event.model, usage: event.usage }) } })
  }
  const { _tag, ...data } = encodeTurnEvent(event)
  return Option.some({ kind: _tag, turn: Option.some(turn), data: _tag === "tool.completed" ? withoutPayload(data) : data })
}

/**
 * The stored form of a memory entry (`memory.*`, `turn.reply`): the entry's
 * id, run, step and time, and `body`, the entry's body without its `_tag`
 * (the kind names it, see `MemoryKindOf`).
 */
export const StoredMemoryData = <Body extends Schema.Top>(body: Body) => Schema.Struct({
  entry: EntryId,
  runId: Schema.String,
  step: Schema.Int,
  at: Schema.Number,
  body,
})

/** Each memory kind's stored schema, from the log body it holds. */
const memorySchemas: ReadonlyArray<readonly [string, Schema.Codec<unknown, unknown>]> = LogBody.members.flatMap((member) =>
  "fields" in member ? [[MemoryKindOf[member.fields._tag.schema.literal], StoredMemoryData(Schema.Struct(Struct.omit(member.fields, ["_tag"])))] as const] : [])

/**
 * Stored bus events whose later keys older records lack: `context.built`
 * has `budgetTokens` from 0.14.0, so a record written before reads without it.
 */
const laterKeys: ReadonlyMap<string, Schema.Codec<unknown, unknown>> = new Map<string, Schema.Codec<unknown, unknown>>([
  ["context.built", Schema.Struct(Struct.evolve(Struct.omit(ContextBuiltEvent.fields, ["_tag"]), { budgetTokens: (field) => Schema.optionalKey(field) }))],
])

/**
 * The stored schema of each bus event in `TURN_EVENT_KINDS` that is stored
 * whole under its own name (`step.usage` is `StepUsageData`, `tool.completed`
 * drops its payload). A bus event left out of `TURN_EVENT_KINDS` has none.
 * A key an older release did not store is optional (`laterKeys`).
 */
const busSchemas: ReadonlyArray<readonly [string, Schema.Codec<unknown, unknown>]> = TurnEvent.members.flatMap((member) => {
  const tag = member.fields._tag.schema.literal
  if (tag === "tool.completed" || !TURN_EVENT_KINDS.includes(tag)) return []
  return [[tag, laterKeys.get(tag) ?? Schema.Struct(Struct.omit(member.fields, ["_tag"]))] as const]
})

const journalSchemas: ReadonlyMap<string, Schema.Codec<unknown, unknown>> = new Map<string, Schema.Codec<unknown, unknown>>([
  ["turn.started", TurnStartedData],
  ["turn.ended", TurnEndedData],
  ["step.usage", StepUsageData],
  ["request.prepared", ModelRequestHeader],
  ["inbox.queued", InboxQueuedData],
  ["inbox.dropped", InboxDroppedData],
  ["tool.completed", Schema.Struct(Struct.omit(ToolCompletedEvent.fields, ["_tag", ...OMITTED_FROM_TOOL_COMPLETED]))],
  ...memorySchemas,
  ...busSchemas,
])

/**
 * The schema the framework stores a journal kind's `data` with: every kind
 * in `RESERVED_KINDS` has one. None for any other kind (a host's records, a
 * plugin's own, such as the tasks plugin's `task.*`).
 */
export const journalSchemaOf = (kind: string): Option.Option<Schema.Codec<unknown, unknown>> => Option.fromNullishOr(journalSchemas.get(kind))
