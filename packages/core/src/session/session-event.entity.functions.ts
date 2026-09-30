import { Effect, Option, Schema } from "effect"
import { canonicalJson } from "../memory/memory-log.entity.functions.js"
import { LogEntry } from "../memory/memory-log.entity.js"
import { TransientTurnEvents, TurnEvent } from "../turn/turn-event.entity.js"
import type { TurnEvent as TurnEventType } from "../turn/turn-event.entity.js"
import { MemoryKindOf, TurnEndedData, TurnStartedData } from "./session-event.entity.js"
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

/** One stored event → the memory entry it is, if it is one. */
export const entryOfEvent = (event: SessionLogEvent): Effect.Effect<Option.Option<LogEntry>, Schema.SchemaError> => {
  if (event.kind === "turn.started") {
    return turnStartedOf(event).pipe(Effect.flatMap((started) => decodeEntry({
      id: started.entry, runId: started.runId, turn: turnOf(event), step: 0, at: started.at,
      body: { _tag: "TurnStarted", prompt: started.userMessage.text },
    })), Effect.map(Option.some))
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

/** Bus events memory or the session records itself: storing them again would be a second copy. */
const recordedElsewhere: ReadonlySet<string> = new Set(["turn.started", "turn.ended", "skills.activated"])

/** A completed tool's input and result are in the memory log (the call and its `memory.tool-result`). */
const withoutPayload = (data: Record<string, unknown>): JsonObject =>
  Object.fromEntries(Object.entries(data).filter(([key]) => key !== "result" && key !== "encoded" && key !== "input"))

/**
 * The stored form of one bus event of turn `turn`: its name and encoded
 * payload. Transient events are not stored; a host's event keeps its name
 * and data; an assistant message is stored only as the step's model and
 * usage (its content is memory's `memory.message`).
 */
export const draftOfTurnEvent = (turn: number, event: TurnEventType): Option.Option<SessionDraft> => {
  if (TransientTurnEvents.includes(event._tag) || recordedElsewhere.has(event._tag)) return Option.none()
  if (event._tag === "host") return Option.some({ kind: event.name, turn: Option.some(turn), data: event.data })
  const { _tag, ...data } = encodeTurnEvent(event)
  if (_tag === "assistant.message") {
    const { step, model, usage } = data as { readonly step: unknown; readonly model: unknown; readonly usage: unknown }
    return Option.some({ kind: "step.usage", turn: Option.some(turn), data: { step, model, usage } })
  }
  return Option.some({ kind: _tag, turn: Option.some(turn), data: _tag === "tool.completed" ? withoutPayload(data) : data })
}
