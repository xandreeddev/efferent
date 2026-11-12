import { Context } from "effect"
import type { Effect } from "effect"
import type { StoredDraft, StoredEvent } from "./event.entity.js"
import type { Seq, SessionId } from "./ids.entity.js"
import type { Journal, StorageError } from "./journal.entity.js"
import type { SessionHeader } from "./session.entity.js"

/**
 * Where journals are kept: a header and its events per session, in order.
 * Storage sees every event as an envelope and never decodes its data. Every
 * refusal is a `StorageError`: a session created twice (`SessionExists`),
 * one never created (`SessionMissing`), an append that expected another
 * journal than the stored one (`SeqConflict`), which writes nothing.
 * `storageConformance` is the contract as runnable checks.
 */
export class Storage extends Context.Service<Storage, {
  /** Store a new session's header; refuses an id that already has one. */
  readonly create: (header: SessionHeader) => Effect.Effect<void, StorageError>
  /** Append an event after `expectedSeq`, the place of the last stored event (0 for none): stamp it with the next place and the time, and return it as stored. */
  readonly append: (id: SessionId, expectedSeq: Seq, event: StoredDraft) => Effect.Effect<StoredEvent, StorageError>
  /** The header and the stored events, in order; with `from`, the events from that place on. */
  readonly read: (id: SessionId, from?: Seq) => Effect.Effect<Journal, StorageError>
}>()("@xandreed/core/kernel/Storage") {}
