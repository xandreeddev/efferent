import { Schema } from "effect"
import { ConversationId, JsonObject, SessionHeader } from "@xandreed/core"

/*
 * The session log as files in a directory: one immutable file per commit,
 * published by an exclusive hard link, so the revision compare-and-swap is
 * the only fencing and no writer ever waits on a lock. Layout under the
 * root (directories 0700, files 0600):
 *
 *   store.json                              the layout's version (`StoreMarker`)
 *   sessions/<id>/header.json               the header, as created (`HeaderRecord`)
 *   sessions/<id>/commits/<revision>.jsonl  the commit that made that revision (`CommitMeta`,
 *                                           `CommitState`, one `CommitEvent` per event, `CommitTrailer`)
 *   sessions/<id>/tmp/                      commits being written, before their link
 *   staging/, trash/                        sessions being created or removed
 *   quarantine/<id>/                        torn tails, kept as they were found
 */

/** The version of the directory's layout; a later one is refused (`store.version`). Shipped: change it only with a migration. */
export const FILES_LAYOUT = 1

/** `store.json`: the layout the directory holds. */
export const StoreMarker = Schema.Struct({ layout: Schema.Int })
export type StoreMarker = typeof StoreMarker.Type

/** A writer's mark on what it published: told apart from another writer's after an answer that may be wrong (a retransmitted link). */
export const PublishNonce = Schema.String.pipe(Schema.brand("PublishNonce"))
export type PublishNonce = typeof PublishNonce.Type

/** `header.json`: the header, the storage time it was created at, and its creator's nonce. */
export const HeaderRecord = Schema.Struct({
  header: SessionHeader,
  createdNow: Schema.Number,
  nonce: PublishNonce,
})
export type HeaderRecord = typeof HeaderRecord.Type

/** A commit file's first line: what it holds, read alone to skip a commit a read does not need. */
export const CommitMeta = Schema.Struct({
  layout: Schema.Int,
  session: ConversationId,
  /** The revision this commit made: its file's name. */
  revision: Schema.Int,
  /** The first event's sequence number, and the session's last after the commit. */
  first: Schema.Int,
  last: Schema.Int,
  /** The storage time: every event's, and the head's `updatedAt`. */
  at: Schema.Number,
  /** The kinds of its events, each once. */
  kinds: Schema.Array(Schema.String),
  nonce: PublishNonce,
})
export type CommitMeta = typeof CommitMeta.Type

/** A commit file's second line: the head's whole state after the commit (a commit without one carries the state before it). */
export const CommitState = Schema.Struct({ state: JsonObject })
export type CommitState = typeof CommitState.Type

/** One event of a commit. */
export const CommitEvent = Schema.Struct({
  seq: Schema.Int,
  turn: Schema.NullOr(Schema.Int),
  kind: Schema.String,
  data: JsonObject,
})
export type CommitEvent = typeof CommitEvent.Type

/** A commit file's last line: the bytes before it and their CRC-32, so a file cut short or changed is told apart from a whole one. */
export const CommitTrailer = Schema.Struct({ bytes: Schema.Int, crc32: Schema.String })
export type CommitTrailer = typeof CommitTrailer.Type

/** A commit file, read whole and checked. */
export interface CommitRecord {
  readonly meta: CommitMeta
  readonly state: JsonObject
  readonly events: ReadonlyArray<CommitEvent>
}

/** Why a commit file is not a whole commit. */
export const CommitDamage = Schema.Literals(["short", "checksum", "decode"])
export type CommitDamage = typeof CommitDamage.Type

/**
 * What to do with a commit file that is not whole: at the session's tail it
 * is a torn tail, set aside (`quarantine`), and the commit before it is the
 * head; anywhere else the session is damaged (`store.decode`), and nothing
 * is moved.
 */
export type TailVerdict =
  | { readonly _tag: "Intact" }
  | { readonly _tag: "Quarantine"; readonly damage: CommitDamage }
  | { readonly _tag: "Corrupt"; readonly damage: CommitDamage }

/** How the store answers while its directory stalls: every call fails at once until one goes through again. */
export type StoreHealth =
  | { readonly _tag: "Healthy" }
  | { readonly _tag: "Stalled"; readonly since: number; readonly probing: boolean }

/**
 * The file store's options: the directory, and how long one file system
 * call may take before the store fails it with `store.stalled` (a hung
 * network mount never answers; the store then fails every call at once
 * until one, let through a `stallMs` later, answers again).
 *
 * @public
 */
export const SessionFilesConfig = Schema.Struct({
  path: Schema.String,
  stallMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(100)),
})
export type SessionFilesConfig = typeof SessionFilesConfig.Type

/** @public */
export const sessionFilesDefaults: SessionFilesConfig = { path: ".efferent/runtime/sessions", stallMs: 10_000 }

/** A file system call failed: its operation, its path, and the file system's own error. */
export class FileStoreIo extends Schema.TaggedError<FileStoreIo>()("FileStoreIo", {
  op: Schema.String,
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

/** A file system call did not answer within `stallMs`. */
export class FileStoreStalled extends Schema.TaggedError<FileStoreStalled>()("FileStoreStalled", {
  op: Schema.String,
  path: Schema.String,
  ms: Schema.Int,
}) {}
