import { Context } from "effect"
import type { Effect } from "effect"
import type { StoredDraft, StoredEvent } from "./event.entity.js"
import type { Seq, SessionId } from "./ids.entity.js"
import type { Journal, JournalStorageError } from "./journal.entity.js"
import type { SessionHeader } from "./session.entity.js"

/**
 * Where journals are kept: a header and its events per session, in order.
 * The store sees every event as an envelope and never decodes its data. Every
 * refusal is a `JournalStorageError`: a session created twice (`SessionExists`),
 * one never created (`SessionMissing`), an append that expected another
 * journal than the stored one (`SeqConflict`), which writes nothing.
 * `journalStorageConformance` is the contract as runnable checks.
 */
export class JournalStorage extends Context.Service<JournalStorage, {
  /** Store a new session's header; refuses an id that already has one. */
  readonly create: (header: SessionHeader) => Effect.Effect<void, JournalStorageError>
  /** Append an event after `expectedSeq`, the place of the last stored event (0 for none): stamp it with the next place and the time, and return it as stored. */
  readonly append: (id: SessionId, expectedSeq: Seq, event: StoredDraft) => Effect.Effect<StoredEvent, JournalStorageError>
  /** The header and the stored events, in order; with `from`, the events from that place on. */
  readonly read: (id: SessionId, from?: Seq) => Effect.Effect<Journal, JournalStorageError>
}>()("@xandreed/core/kernel/JournalStorage") {}
