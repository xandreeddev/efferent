import { Schema } from "effect"
import { EventName, Seq, SessionId, TurnNumber } from "./ids.entity.js"
import { Message } from "./message.entity.js"

/** The shape of a tag: one word, or `<plugin>.<tag>`. */
export const TAG_SHAPE = /^[a-z0-9][a-z0-9-]*(\.[a-z][a-z0-9-]*)?$/

/** The tags the kernel reserves: one word each. Any other tag is a plugin's own, `<plugin>.<tag>`. */
export const RESERVED_TAGS = ["conversation", "turn", "memory", "ui", "trace"] as const

/**
 * A tag the kernel reserves: `conversation` (what memory builds the context
 * from), `turn` (the session's own structure), `memory` (a memory's derived
 * state), `ui` (what a client draws) and `trace` (side work that is not the
 * conversation).
 *
 * @public
 */
export type ReservedTag = (typeof RESERVED_TAGS)[number]

/**
 * A tag as a definition declares it: one of the reserved words, or a
 * plugin's own, `<plugin>.<tag>`. A one-word tag that is not reserved (a
 * misspelt `conversation`) does not type, and is refused where the
 * definition is made.
 *
 * @public
 */
export type DefinitionTag = ReservedTag | `${string}.${string}`

/**
 * What a record or a live event is for, so a part that reads the journal
 * takes only what it rebuilds from: a reserved tag (`ReservedTag`) or a
 * plugin's own, `<plugin>.<tag>`. A definition declares its tags once, and
 * every event of it carries them. The schema checks the shape only, so a
 * stored record with a tag a later kernel reserved still decodes; the words
 * are checked where a definition is made (`storedEvent`, `liveEvent`).
 *
 * @public
 */
export const Tag = Schema.String.check(Schema.isPattern(TAG_SHAPE)).pipe(Schema.brand("Tag"))
export type Tag = typeof Tag.Type

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
  readonly tags: ReadonlyArray<Tag>
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
  readonly tags: ReadonlyArray<Tag>
}

/** An event's definition, stored or live. The set of them is open: core holds no list. */
export type EventDefinition<D extends Schema.Json> = StoredDefinition<D> | LiveDefinition<D>

const envelope = {
  name: EventName,
  /** The event's own data, as JSON; storage never decodes it. */
  data: Schema.Json,
  /** Whether a reader that does not know this record may pass over it. */
  skippable: Schema.Boolean,
  /** What the record is for, as its definition declares: a reader filters by it (`taggedWith`). */
  tags: Schema.Array(Tag),
  /**
   * The message this record bears, when it bears one. A message sits here and nowhere else. What a message stands
   * for (a summary of earlier records, say) is the writing plugin's own data, not the envelope's.
   */
  message: Schema.optionalKey(Message),
}

/**
 * An event on its way into the journal: what `session.append` takes. Only
 * `stored`, from a stored definition, makes one (core's `userMessage`,
 * `assistantMessage` and `toolResult` are built with it): an object written
 * by hand does not type, and a session refuses it (`NotADraft`), so a record
 * always carries the tags and the skip flag of its definition.
 */
export const StoredDraft = Schema.Struct(envelope).pipe(Schema.brand("StoredDraft"))
export type StoredDraft = typeof StoredDraft.Type

/** An event as the journal keeps it: the draft, where it is, the turn it was stored in, and when. */
export const StoredEvent = Schema.Struct({ seq: Seq, at: Schema.Number, turn: TurnNumber, ...envelope })
export type StoredEvent = typeof StoredEvent.Type

/**
 * An event that is published and stored nowhere, with the session it is
 * about and, for an event inside a turn, the turn: an event about the
 * session and no turn of it (a message queued before its turn opens) has
 * none. Built with `live` from a live definition.
 */
export const LiveEvent = Schema.TaggedStruct("Live", { session: SessionId, turn: Schema.optionalKey(TurnNumber), name: EventName, tags: Schema.Array(Tag), data: Schema.Json })
export type LiveEvent = typeof LiveEvent.Type

/** A stored event as it is announced, with the session and turn it is about. */
export const AnnouncedEvent = Schema.TaggedStruct("Stored", { session: SessionId, ...StoredEvent.fields })
export type AnnouncedEvent = typeof AnnouncedEvent.Type

/** What `Core` carries: a stored event announced after it reached the journal, or a live one. Told apart by `_tag`, never by a list of names. */
export const KernelEvent = Schema.Union([AnnouncedEvent, LiveEvent])
export type KernelEvent = typeof KernelEvent.Type

/**
 * A stored record as a listener of its definition receives it: the record
 * as announced (its place, its turn, the message it bears), with the data
 * its definition describes.
 *
 * @public
 */
export type StoredDelivery<D> = Omit<AnnouncedEvent, "data"> & { readonly data: D }

/**
 * A live event as a listener of its definition receives it, with the data its definition describes.
 *
 * @public
 */
export type LiveDelivery<D> = Omit<LiveEvent, "data"> & { readonly data: D }

/**
 * An event as a listener receives it, when the kind of its definition is not known: stored or live.
 *
 * @public
 */
export type Delivered<D> = StoredDelivery<D> | LiveDelivery<D>

/**
 * What a listener of `Definition` receives: a stored record for a stored
 * definition, a live event for a live one, so a handler reads `event.seq` or
 * `event.message` without telling the two apart first.
 *
 * @public
 */
export type DeliveryOf<Definition> =
  Definition extends StoredDefinition<infer D> ? StoredDelivery<D>
    : Definition extends LiveDefinition<infer D> ? LiveDelivery<D>
      : never

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
