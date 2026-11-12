import { Schema } from "effect"
import { EventName, Seq, SessionId, TurnNumber } from "./ids.entity.js"
import { Message } from "./message.entity.js"

/**
 * The definition of an event the journal keeps: its name, the schema of its
 * data, and whether a reader that does not know it may skip it. Any plugin
 * defines its own with `storedEvent`.
 *
 * @public
 */
export interface StoredDefinition<D extends Schema.Json> {
  readonly kind: "stored"
  readonly name: EventName
  readonly data: Schema.Codec<D, Schema.Json>
  readonly skippable: boolean
}

/**
 * The definition of an event that is published and never stored. Any plugin
 * defines its own with `liveEvent`.
 *
 * @public
 */
export interface LiveDefinition<D extends Schema.Json> {
  readonly kind: "live"
  readonly name: EventName
  readonly data: Schema.Codec<D, Schema.Json>
}

/** An event's definition, stored or live. The set of them is open: core holds no list. */
export type EventDefinition<D extends Schema.Json> = StoredDefinition<D> | LiveDefinition<D>

/**
 * A run of the journal, both ends included.
 *
 * @public
 */
export const SeqRange = Schema.Struct({ from: Seq, through: Seq })
export type SeqRange = typeof SeqRange.Type

const envelope = {
  name: EventName,
  /** The event's own data, as JSON; storage never decodes it. */
  data: Schema.Json,
  /** Whether a reader that does not know this record may pass over it. */
  skippable: Schema.Boolean,
  /** The message this record bears, when it bears one. A message sits here and nowhere else. */
  message: Schema.optionalKey(Message),
  /** The run of the journal this record's message stands for, when it replaces one. */
  replaces: Schema.optionalKey(SeqRange),
}

const replacesAMessage = Schema.makeFilter((event: { readonly message?: Message; readonly replaces?: SeqRange }) =>
  event.replaces === undefined || event.message !== undefined ? true : "a record that replaces a range bears the message that stands for it")

/** An event on its way into the journal: what `session.append` takes. Built with `stored` from a stored definition. */
export const StoredDraft = Schema.Struct(envelope).check(replacesAMessage)
export type StoredDraft = typeof StoredDraft.Type

/** An event as the journal keeps it: the draft, where it is and when it was stored. */
export const StoredEvent = Schema.Struct({ seq: Seq, at: Schema.Number, ...envelope }).check(replacesAMessage)
export type StoredEvent = typeof StoredEvent.Type

/** An event that is published and stored nowhere, with the session and turn it is about. Built with `live` from a live definition. */
export const LiveEvent = Schema.TaggedStruct("Live", { session: SessionId, turn: TurnNumber, name: EventName, data: Schema.Json })
export type LiveEvent = typeof LiveEvent.Type

/** A stored event as it is announced, with the session and turn it is about. */
export const AnnouncedEvent = Schema.TaggedStruct("Stored", { session: SessionId, turn: TurnNumber, seq: Seq, at: Schema.Number, ...envelope })
export type AnnouncedEvent = typeof AnnouncedEvent.Type

/** What `Core` carries: a stored event announced after it reached the journal, or a live one. Told apart by `_tag`, never by a list of names. */
export const KernelEvent = Schema.Union([AnnouncedEvent, LiveEvent])
export type KernelEvent = typeof KernelEvent.Type

/** An event as a listener receives it: the envelope, with the data its definition describes. */
export type Delivered<D> = (Omit<AnnouncedEvent, "data"> | Omit<LiveEvent, "data">) & { readonly data: D }

/**
 * A listener that was waited for failed, or was cut short: which listener, on which event, and why.
 *
 * @public
 */
export class ListenerFailed extends Schema.TaggedError<ListenerFailed>()("ListenerFailed", {
  listener: Schema.String,
  event: EventName,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * A failure a plugin raises: any tagged error with a message. The contracts
 * carry it, so a plugin's own error reaches the caller as it was raised.
 *
 * @public
 */
export interface PluginFailure {
  readonly _tag: string
  readonly message: string
}
