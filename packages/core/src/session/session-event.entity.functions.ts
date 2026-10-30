import { Effect, Option, Schema, Struct } from "effect"
import { RunId } from "../domain/run.entity.js"
import { sumUsage } from "../domain/token-usage.entity.functions.js"
import type { TokenUsage } from "../domain/token-usage.entity.js"
import { TurnOutcomeKind } from "../domain/turn-vocabulary.entity.js"
import { canonicalJson } from "../memory/memory-log.entity.functions.js"
import { EntryId, LogBody, LogEntry } from "../memory/memory-log.entity.js"
import { ModelRequestHeader } from "../turn/model-request.entity.js"
import { ContextBuiltEvent, ToolCompletedEvent, ToolRefusedEvent, TransientTurnEvents, TurnEvent } from "../turn/turn-event.entity.js"
import type { TurnEvent as TurnEventType } from "../turn/turn-event.entity.js"
import {
  InboxDroppedData,
  InboxQueuedData,
  MemoryKindOf,
  RECORDED_ELSEWHERE,
  RESERVED_KINDS,
  StepUsageData,
  TURN_EVENT_KINDS,
  TurnEndedData,
  TurnStartedData,
} from "./session-event.entity.js"
import type { TurnEndedData as TurnEnded, TurnStartedData as TurnStarted } from "./session-event.entity.js"
import { storedJson } from "./session-log.entity.functions.js"
import { JsonObject as JsonObjectSchema } from "./session-log.entity.js"
import type { JsonObject, SessionDraft, SessionLogEvent } from "./session-log.entity.js"
// The declarations this module emits name the user message through this import, not another package.
import type { UserMessage } from "../turn/user-message.entity.js"

const encodeEntry = Schema.encodeEffect(LogEntry)
const decodeEntry = Schema.decodeUnknownEffect(LogEntry)
const encodeTurnEvent = Schema.encodeEffect(TurnEvent)
const tagOfKind: ReadonlyMap<string, string> = new Map(Object.entries(MemoryKindOf).map(([tag, kind]) => [kind, tag]))

const decodeCanonical = Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObjectSchema))

/** Stored JSON read back with sorted keys: every store gives the same bytes, as the canonical log did. */
const canonical = (data: JsonObject): Effect.Effect<JsonObject, Schema.SchemaError> => decodeCanonical(canonicalJson(data))

const turnOf = (event: SessionLogEvent): number => Option.getOrElse(event.turn, () => 0)

/**
 * One memory entry → the draft it is stored as: its own kind, the entry's
 * id, run, step and time, and the body, as JSON (`storedJson`). TurnStarted
 * has none: the turn's `turn.started` (written when the turn begins) is
 * that entry.
 */
export const draftOfEntry = (entry: LogEntry): Effect.Effect<Option.Option<SessionDraft>, Schema.SchemaError> =>
  entry.body._tag === "TurnStarted" ? Effect.succeed(Option.none()) : encodeEntry(entry).pipe(Effect.flatMap((encoded) => {
    const { _tag, ...body } = encoded.body
    const kind = MemoryKindOf[_tag as keyof typeof MemoryKindOf]
    return storedJson({ entry: encoded.id, runId: encoded.runId, step: encoded.step, at: encoded.at, body }).pipe(
      Effect.map((data) => Option.some({ kind, turn: Option.some(entry.turn), data })),
    )
  }))

export const draftsOfEntries = (entries: ReadonlyArray<LogEntry>): Effect.Effect<ReadonlyArray<SessionDraft>, Schema.SchemaError> =>
  Effect.forEach(entries, draftOfEntry, { concurrency: 1 }).pipe(Effect.map((drafts) => drafts.flatMap(Option.toArray)))

/** What a framework draft carries; a symbol of the global registry, so every copy of core agrees on it. */
const FRAMEWORK_DRAFT = Symbol.for("efferent/FrameworkDraft")

/**
 * A draft the framework's turn writes through its `TurnWriter`, marked as
 * the framework's: the writer stores it under a reserved kind
 * (`RESERVED_KINDS`), where it refuses any other draft. `TurnLive` marks
 * memory's events, the bus's and `request.prepared`; a host or plugin never
 * needs it (a test standing in for the turn does).
 */
export const frameworkDraft = (kind: string, data: JsonObject): { readonly kind: string; readonly data: JsonObject } =>
  Object.assign({ kind, data }, { [FRAMEWORK_DRAFT]: true })

/** Whether `frameworkDraft` made this draft. */
export const isFrameworkDraft = (draft: { readonly kind: string }): boolean => FRAMEWORK_DRAFT in draft

/** The first of these drafts under a reserved kind that the framework did not write (`frameworkDraft`), if any. */
export const unmarkedReservedDraft = <D extends { readonly kind: string }>(drafts: ReadonlyArray<D>): Option.Option<D> =>
  Option.fromNullishOr(drafts.find((draft) => RESERVED_KINDS.includes(draft.kind) && !isFrameworkDraft(draft)))

/** The draft that opens a turn. */
export const turnStartedDraft = (turn: number, data: TurnStarted): Effect.Effect<SessionDraft, Schema.SchemaError> =>
  Schema.encodeEffect(TurnStartedData)(data).pipe(Effect.map((encoded) => ({ kind: "turn.started", turn: Option.some(turn), data: { ...encoded } })))

/** The draft that closes a turn. */
export const turnEndedDraft = (turn: number, data: TurnEnded): Effect.Effect<SessionDraft, Schema.SchemaError> =>
  Schema.encodeEffect(TurnEndedData)(data).pipe(Effect.map((encoded) => ({ kind: "turn.ended", turn: Option.some(turn), data: { ...encoded } })))

/**
 * The schema of each kind the framework reads back by its fields (the
 * session's own records, a step's usage, a request's header): a reader
 * decodes the data with it (`readStored`), never reads `event.data` unchecked.
 */
export const StoredData = {
  "turn.started": TurnStartedData,
  "turn.ended": TurnEndedData,
  "inbox.queued": InboxQueuedData,
  "inbox.dropped": InboxDroppedData,
  "step.usage": StepUsageData,
  "request.prepared": ModelRequestHeader,
} as const
export type StoredKind = keyof typeof StoredData

/**
 * One stored event of a `StoredData` kind, and its data decoded.
 *
 * @public
 */
export interface Stored<K extends StoredKind> {
  readonly event: SessionLogEvent
  readonly data: (typeof StoredData)[K]["Type"]
}

/** Each kind's decoder, built once. */
const storedDecoders: { readonly [K in StoredKind]: (data: unknown) => Effect.Effect<(typeof StoredData)[K]["Type"], Schema.SchemaError> } = {
  "turn.started": Schema.decodeUnknownEffect(TurnStartedData),
  "turn.ended": Schema.decodeUnknownEffect(TurnEndedData),
  "inbox.queued": Schema.decodeUnknownEffect(InboxQueuedData),
  "inbox.dropped": Schema.decodeUnknownEffect(InboxDroppedData),
  "step.usage": Schema.decodeUnknownEffect(StepUsageData),
  "request.prepared": Schema.decodeUnknownEffect(ModelRequestHeader),
}

/** One event's data decoded as `kind`'s, read with sorted keys (`canonical`), whatever its own kind. */
const decodeStored = <K extends StoredKind>(kind: K, event: SessionLogEvent): Effect.Effect<(typeof StoredData)[K]["Type"], Schema.SchemaError> =>
  canonical(event.data).pipe(Effect.flatMap(storedDecoders[kind]))

/**
 * The events of `kind` among these, in order, each with its data decoded.
 * The first that does not decode fails the read with its `SchemaError`: a
 * caller fails with its own code for undecodable stored data
 * (`session.decode`), never skips the row.
 */
export const readStored = <K extends StoredKind>(kind: K, events: ReadonlyArray<SessionLogEvent>): Effect.Effect<ReadonlyArray<Stored<K>>, Schema.SchemaError> =>
  Effect.forEach(events.filter((event) => event.kind === kind), (event) =>
    decodeStored(kind, event).pipe(Effect.map((data): Stored<K> => ({ event, data }))), { concurrency: 1 })

/**
 * What a lookup of a `turn.started` decodes: its run, key and entry, never
 * the user's message (its images are base64).
 *
 * @public
 */
export const TurnStartedKeys = TurnStartedData.mapFields(Struct.pick(["runId", "key", "entry"]))
/**
 * What a lookup of a `request.prepared` decodes: its run id, run and step,
 * never its system text and tools.
 *
 * @public
 */
export const RequestPreparedKeys = ModelRequestHeader.mapFields(Struct.pick(["runId", "run", "step"]))

/**
 * The kinds a lookup finds by a few keys, and the keys it decodes
 * (`readStoredKeys`).
 *
 * @public
 */
export const StoredKeys = {
  "turn.started": TurnStartedKeys,
  "request.prepared": RequestPreparedKeys,
} as const
/** @public */
export type KeyedKind = keyof typeof StoredKeys

/**
 * One stored event of a `StoredKeys` kind, and its keys decoded.
 *
 * @public
 */
export interface StoredKeysOf<K extends KeyedKind> {
  readonly event: SessionLogEvent
  readonly keys: (typeof StoredKeys)[K]["Type"]
}

const keyDecoders: { readonly [K in KeyedKind]: (data: unknown) => Effect.Effect<(typeof StoredKeys)[K]["Type"], Schema.SchemaError> } = {
  "turn.started": Schema.decodeUnknownEffect(TurnStartedKeys),
  "request.prepared": Schema.decodeUnknownEffect(RequestPreparedKeys),
}

/**
 * The events of `kind` among these, in order, each with only its keys
 * decoded (`StoredKeys`): how a lookup finds a turn by its key or run, or a
 * request by its run id, run and step, without decoding (or copying) the rest. It
 * fails as `readStored` does; decode the one event found with `readStored`.
 */
export const readStoredKeys = <K extends KeyedKind>(kind: K, events: ReadonlyArray<SessionLogEvent>): Effect.Effect<ReadonlyArray<StoredKeysOf<K>>, Schema.SchemaError> =>
  Effect.forEach(events.filter((event) => event.kind === kind), (event) =>
    keyDecoders[kind](event.data).pipe(Effect.map((keys): StoredKeysOf<K> => ({ event, keys }))), { concurrency: 1 })

/** A stored `turn.started`, decoded. */
export const turnStartedOf = (event: SessionLogEvent): Effect.Effect<TurnStarted, Schema.SchemaError> => decodeStored("turn.started", event)

/** A stored `turn.ended`, decoded. */
export const turnEndedOf = (event: SessionLogEvent): Effect.Effect<TurnEnded, Schema.SchemaError> => decodeStored("turn.ended", event)

/** What of a `turn.reply` tells how its turn came out: its body's outcome. */
const decodeReplyOutcome = Schema.decodeUnknownOption(Schema.Struct({ body: Schema.Struct({ outcome: TurnOutcomeKind }) }))

/**
 * The ending the turn's reply among these drafts implies (the last
 * `turn.reply`, as the turn holds it for its closing commit): its outcome,
 * completed or partial, with no failure. None for a failed reply, one that
 * does not decode, or no reply: how such a turn ended is told by its failure.
 */
export const replyEndingOf = (drafts: ReadonlyArray<{ readonly kind: string; readonly data: JsonObject }>): Option.Option<TurnEnded> =>
  Option.fromNullishOr(drafts.filter((draft) => draft.kind === MemoryKindOf.TurnEnded).at(-1)).pipe(
    Option.flatMap((draft) => decodeReplyOutcome(draft.data)),
    Option.flatMap((stored) => stored.body.outcome === "failed" ? Option.none() : Option.some<TurnEnded>({ reason: stored.body.outcome, failure: Option.none() })),
  )

/**
 * The stored form of a memory entry (`memory.*`, `turn.reply`): the entry's
 * id, run, step and time, and `body`, the entry's body without its `_tag`
 * (the kind names it, see `MemoryKindOf`).
 *
 * @public
 */
export const StoredMemoryData = <Body extends Schema.Top>(body: Body) => Schema.Struct({
  entry: EntryId,
  runId: RunId,
  step: Schema.Int,
  at: Schema.Number,
  body,
})

/** A memory kind's stored data with its body as JSON: the entry's own schema decodes the body. */
const decodeMemoryData = Schema.decodeUnknownEffect(StoredMemoryData(JsonObjectSchema))

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
  return canonical(event.data).pipe(
    Effect.flatMap(decodeMemoryData),
    Effect.flatMap((data) => decodeEntry({ id: data.entry, runId: data.runId, turn: turnOf(event), step: data.step, at: data.at, body: { ...data.body, _tag: tag } })),
    Effect.map(Option.some),
  )
}

/** The memory log held in a session's events, in log order. */
export const entriesOfEvents = (events: ReadonlyArray<SessionLogEvent>): Effect.Effect<ReadonlyArray<LogEntry>, Schema.SchemaError> =>
  Effect.forEach(events, entryOfEvent, { concurrency: 1 }).pipe(Effect.map((entries) => entries.flatMap(Option.toArray)))

/** A completed tool's input and result are in the memory log (the call and its `memory.tool-result`). */
const OMITTED_FROM_TOOL_COMPLETED = ["result", "encoded", "input"] as const

/** A refused call's input is in the memory log too (the model's call); the refusal keeps why. */
const OMITTED_FROM_TOOL_REFUSED = ["input"] as const

const without = (omitted: ReadonlyArray<string>) => (data: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> =>
  Object.fromEntries(Object.entries(data).filter(([key]) => !omitted.includes(key)))

/** What a bus event stored under its own name leaves out. */
const storedPayload: ReadonlyMap<string, (data: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>> = new Map([
  ["tool.completed", without(OMITTED_FROM_TOOL_COMPLETED)],
  ["tool.refused", without(OMITTED_FROM_TOOL_REFUSED)],
])

const encodeStepUsage = Schema.encodeEffect(StepUsageData)

/**
 * Turn `turn`'s usage from a session's stored events: its `step.usage`
 * records summed, which is what the turn's `assistant.message` events
 * carried (`TurnResult.usage`, `turn.ended.usage`). A record written before
 * 0.14.0 reads 0 cache-write and reasoning tokens.
 */
export const turnUsageOf = (events: ReadonlyArray<SessionLogEvent>, turn: number): Effect.Effect<TokenUsage, Schema.SchemaError> =>
  readStored("step.usage", events.filter((event) => Option.contains(event.turn, turn))).pipe(
    Effect.map((records) => sumUsage(records.map((record) => record.data.usage))),
  )

/**
 * The stored form of one bus event of turn `turn`: its name and encoded
 * payload. Transient events are not stored; a host's event keeps its name
 * and data; an assistant message is stored only as the step's run, model and
 * usage (its content is memory's `memory.message`); `tool.completed` leaves
 * out its input and result, `tool.refused` its input. The payload is stored
 * as JSON (`storedJson`: `undefined` fields dropped). An event its schema
 * does not encode (a value its type allows but a check refuses, such as a
 * non-integer step), or whose payload JSON cannot hold (a BigInt in a host
 * event's data), fails with the `SchemaError`, never throws.
 */
export const draftOfTurnEvent = (turn: number, event: TurnEventType): Effect.Effect<Option.Option<SessionDraft>, Schema.SchemaError> => {
  if (TransientTurnEvents.includes(event._tag) || RECORDED_ELSEWHERE.has(event._tag)) return Effect.succeed(Option.none())
  type Drafted = Effect.Effect<Option.Option<SessionDraft>, Schema.SchemaError>
  return TurnEvent.matchOrElse(event, {
    host: (host): Drafted => storedJson(host.data).pipe(Effect.map((data) => Option.some({ kind: host.name, turn: Option.some(turn), data }))),
    "assistant.message": (message): Drafted => encodeStepUsage({ step: message.step, run: message.run, model: message.model, usage: message.usage, finishReason: message.finishReason }).pipe(
      Effect.map((encoded) => Option.some({ kind: "step.usage", turn: Option.some(turn), data: { ...encoded } })),
    ),
  }, (stored): Drafted => encodeTurnEvent(stored).pipe(Effect.flatMap(({ _tag, ...data }) =>
    storedJson(Option.match(Option.fromNullishOr(storedPayload.get(_tag)), { onNone: () => data, onSome: (payload) => payload(data) })).pipe(
      Effect.map((json) => Option.some({ kind: _tag, turn: Option.some(turn), data: json })),
    ))))
}

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
 * and `tool.refused` drop their payload). A bus event left out of
 * `TURN_EVENT_KINDS` has none. A key an older release did not store is
 * optional (`laterKeys`).
 */
const busSchemas: ReadonlyArray<readonly [string, Schema.Codec<unknown, unknown>]> = TurnEvent.members.flatMap((member) => {
  const tag = member.fields._tag.schema.literal
  if (storedPayload.has(tag) || !TURN_EVENT_KINDS.includes(tag)) return []
  return [[tag, laterKeys.get(tag) ?? Schema.Struct(Struct.omit(member.fields, ["_tag"]))] as const]
})

const journalSchemas: ReadonlyMap<string, Schema.Codec<unknown, unknown>> = new Map<string, Schema.Codec<unknown, unknown>>([
  ...Object.entries(StoredData),
  ["tool.completed", Schema.Struct(Struct.omit(ToolCompletedEvent.fields, ["_tag", ...OMITTED_FROM_TOOL_COMPLETED]))],
  ["tool.refused", Schema.Struct(Struct.omit(ToolRefusedEvent.fields, ["_tag", ...OMITTED_FROM_TOOL_REFUSED]))],
  ...memorySchemas,
  ...busSchemas,
])

/**
 * The schema the framework stores a journal kind's `data` with: every kind
 * in `JOURNAL_KINDS` has one. None for any other kind: a host's records, a
 * plugin's own (such as the tasks plugin's `task.*`), and the reserved bus
 * names never stored under their own name (`assistant.message`,
 * `tool.progress`…).
 */
export const journalSchemaOf = (kind: string): Option.Option<Schema.Codec<unknown, unknown>> => Option.fromNullishOr(journalSchemas.get(kind))
