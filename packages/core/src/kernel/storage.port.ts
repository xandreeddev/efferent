import { Context } from "effect"
import type { Effect } from "effect"
import type { Seq, SessionId } from "./ids.entity.js"
import type { Journal, StorageError, StoredEvent } from "./journal.entity.js"
import type { SessionHeader } from "./session.entity.js"

/**
 * Where journals are kept: a header and its events per session, in order.
 * Storage sees every event as an envelope and never decodes its data. Every
 * refusal is a `StorageError`: a session created twice (`SessionExists`),
 * one never created (`SessionMissing`), an append that expected another
 * journal than the stored one (`SeqConflict`), which writes nothing.
 * `storageConformance` is the contract as runnable checks.
 *
 * @public
 */
export class Storage extends Context.Service<Storage, {
  /** Store a new session's header; refuses an id that already has one. */
  readonly create: (header: SessionHeader) => Effect.Effect<void, StorageError>
  /** Append events after `expectedSeq`, the place of the last stored event (0 for none), all of them or none. */
  readonly append: (id: SessionId, expectedSeq: Seq, events: ReadonlyArray<StoredEvent>) => Effect.Effect<void, StorageError>
  /** The header and the stored events, in order; with `from`, the events from that place on. */
  readonly read: (id: SessionId, from?: Seq) => Effect.Effect<Journal, StorageError>
}>()("@xandreed/core/kernel/Storage") {}
