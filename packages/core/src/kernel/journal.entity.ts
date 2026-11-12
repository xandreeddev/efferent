import { Schema } from "effect"
import { EventName, Seq } from "./ids.entity.js"
import { SessionHeader } from "./session.entity.js"

/** An event as storage keeps it: where it is, when it was stored, its name and its data, which storage never decodes. */
export const StoredEvent = Schema.Struct({ seq: Seq, at: Schema.Number, name: EventName, data: Schema.Json })
export type StoredEvent = typeof StoredEvent.Type

/**
 * A session as storage holds it: its header and its events, in order.
 *
 * @public
 */
export const Journal = Schema.Struct({ header: SessionHeader, events: Schema.Array(StoredEvent) })
export type Journal = typeof Journal.Type

/**
 * A storage call that was refused or could not run: a session created twice
 * (`SessionExists`), one that was never created (`SessionMissing`), an
 * append that expected another journal than the stored one (`SeqConflict`),
 * or a store that cannot be reached (`Unavailable`).
 *
 * @public
 */
export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
  reason: Schema.Literals(["SessionExists", "SessionMissing", "SeqConflict", "Unavailable"]),
  message: Schema.String,
}) {}
