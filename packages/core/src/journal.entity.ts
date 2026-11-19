import { Schema } from "effect"
import { StoredEvent } from "./event.entity.js"
import { EventName, Seq } from "./ids.entity.js"
import { SessionHeader } from "./session.entity.js"

/** A session as storage holds it: its header and its events, in order. */
export const Journal = Schema.Struct({ header: SessionHeader, events: Schema.Array(StoredEvent) })
export type Journal = typeof Journal.Type

/**
 * A storage call that was refused or could not run: a session created twice
 * (`SessionExists`), one that was never created (`SessionMissing`), an
 * append that expected another journal than the stored one (`SeqConflict`),
 * a store that cannot be reached or written now (`Unavailable`), or a
 * stored value that is not a journal's (`Unreadable`): trying again does
 * not help that one.
 */
export class JournalStorageError extends Schema.TaggedError<JournalStorageError>()("JournalStorageError", {
  reason: Schema.Literals(["SessionExists", "SessionMissing", "SeqConflict", "Unavailable", "Unreadable"]),
  message: Schema.String,
}) {}

/**
 * What a part reads of a journal: the prefixes it answers for, and the
 * record names under them it knows. Plain data, built with `vocabularyOf`.
 */
export const Vocabulary = Schema.Struct({ reads: Schema.Array(Schema.String), knows: Schema.Array(EventName) })
export type Vocabulary = typeof Vocabulary.Type

/** A journal read with a vocabulary held a record under one of its prefixes that the vocabulary does not know, and the record does not say it may be skipped. */
export class UnknownRecord extends Schema.TaggedError<UnknownRecord>()("UnknownRecord", {
  name: EventName,
  seq: Seq,
  message: Schema.String,
}) {}
