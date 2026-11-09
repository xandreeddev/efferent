import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { Cause, Clock, Effect, Layer, Match, Option, Ref, Result, Schema } from "effect"
import type { Scope } from "effect"
import {
  ConversationId,
  errorCodeOf,
  LeaseExpired,
  reasonOf,
  RevisionConflict,
  SessionExists,
  SessionIncarnation,
  SessionLog,
  SessionLogError,
  SessionMissing,
  storedJson,
} from "@xandreed/core"
import type { JsonObject, SessionCommit, SessionCommitted, SessionHead, SessionHeader, SessionListQuery, SessionLogEvent, SessionReadQuery, SessionRef } from "@xandreed/core"
import { nodeFilesIo } from "./files-io.adapter.js"
import { makeBoundedFilesCall } from "./bounded-call.adapter.js"
import type { FilesIo } from "./files-io.adapter.js"
import { FILES_LAYOUT, PublishNonce, sessionFilesDefaults, STAGING_SWEEP_MS } from "./session-files.entity.js"
import type { CommitEvent, CommitMeta, CommitRecord, FileStoreIo, FileStoreStalled, HeaderRecord } from "./session-files.entity.js"
import {
  CACHE_BOUNDS,
  decodeCommit,
  encodeCommit,
  headerOfText,
  headerText,
  inListing,
  isAbandonedStaging,
  isSessionDirectory,
  markerOfText,
  metaOfLine,
  page,
  revisionFile,
  revisionOfFile,
  revisionOfTemporary,
  sameBytes,
  stagingName,
  tailVerdict,
  trimCache,
} from "./session-files.entity.functions.js"

/**
 * The store's options beyond its directory: the stall bound, and the file system calls (a test's seam).
 *
 * @public
 */
export interface SessionLogFilesOptions {
  readonly stallMs?: number
  readonly io?: FilesIo
}

type Failed = FileStoreIo | FileStoreStalled

/** A commit as the session's tail holds it: the head's facts after it. */
interface Tail {
  readonly revision: number
  readonly seq: number
  readonly at: number
  readonly state: JsonObject
}

/** What a handle knows of a session it read: the header's nonce (a removed and created again session has another), its tail, and the metas it read. */
interface Known {
  readonly nonce: PublishNonce
  readonly tail: Tail
  readonly metas: ReadonlyMap<number, CommitMeta>
}

/** What publishing a commit came to. */
type Published =
  | { readonly _tag: "Published" }
  | { readonly _tag: "Taken" }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Expired"; readonly notAfter: number; readonly now: number }
  | { readonly _tag: "Replaced" }

/** What setting a torn tail aside came to: it is aside, or what was moved was another writer's whole commit, put back. */
type SetAside = "aside" | "restored"

const META_PREFIX = 65_536
/** A name under `sessions/` as the session's id; none for any other name (`isSessionDirectory`). */
const sessionIdOf = (name: string): Option.Option<ConversationId> =>
  isSessionDirectory(name) ? Schema.decodeUnknownOption(ConversationId)(name) : Option.none()
const encoder = new TextEncoder()
const decoder = new TextDecoder()

const isCode = (error: Failed, ...codes: ReadonlyArray<string>): boolean =>
  error._tag === "FileStoreIo" && Option.exists(errorCodeOf(error.cause), (code) => codes.includes(code))

/** A store failure whose cause is a file that is not there (its session's directory included). */
const vanished = (error: SessionMissing | SessionLogError): boolean =>
  error._tag === "SessionLogError" && Option.exists(errorCodeOf(error.cause), (code) => code === "ENOENT" || code === "ENOTDIR")

/** A pipeable of `Effect.fn`: the session's id on the span the call opens, as `efferent.session.id`. */
const onSession = <A, E, R>(effect: Effect.Effect<A, E, R>, id: ConversationId): Effect.Effect<A, E, R> =>
  Effect.annotateCurrentSpan("efferent.session.id", id).pipe(Effect.andThen(effect))

/**
 * A store failure as the port's `SessionLogError`: `store.stalled` for a
 * call that did not answer within the stall bound (a commit's outcome is
 * then unknown until the head is read again: it may land), else `code`,
 * the file system's error as its cause.
 */
const storeError = (code: string, what: string) => (error: Failed): SessionLogError => Match.valueTags(error, {
  FileStoreStalled: (stalled) => new SessionLogError({
    code: "store.stalled",
    message: `the session directory did not answer ${stalled.op} of ${stalled.path} within ${stalled.ms} ms; a write it held may still land`,
  }),
  FileStoreIo: (failed) => new SessionLogError({ code, message: `the session directory failed to ${what}: ${reasonOf(Cause.die(failed.cause))}`, cause: failed.cause }),
})

const decodeError = (what: string, detail: string) => new SessionLogError({ code: "store.decode", message: `${what} does not decode: ${detail}` })

/** A session as diagnostics name it: its id and incarnation, never the reference object. */
const describe = (id: SessionRef): string => `${id.id} (incarnation ${id.incarnation})`

/** A session's incarnation: its header's nonce, which a session created again under its id never shares. */
const incarnationOf = (header: HeaderRecord): SessionIncarnation => SessionIncarnation.make(header.nonce)

/** The cache with `id`'s entry the most recently used, within the handle's bounds; an entry over them keeps its highest revisions' metas. */
const cacheWith = (all: ReadonlyMap<string, Known>, id: string, entry: Known): ReadonlyMap<string, Known> =>
  trimCache(new Map([...all].filter(([key]) => key !== id)).set(id, entry), (known) => known.metas.size, (known, kept) => ({
    ...known,
    metas: new Map([...known.metas].toSorted(([left], [right]) => left - right).slice(known.metas.size - kept)),
  }), CACHE_BOUNDS)

/**
 * The session log as files in a directory, local or on a network mount
 * (NFS), on Node 24 and Bun: one immutable file per commit, written to a
 * temporary file, flushed, then published by an exclusive hard link to its
 * revision's name. Exactly one writer wins each revision, so a commit is a
 * compare-and-swap without a lock: no handle waits on another, and a handle
 * whose process stopped blocks nobody. A publish whose answer may be wrong
 * (a network file system's retransmitted link) is settled by reading the
 * published file's nonce. A commit's `notAfter` is checked again once its
 * file is written, right before the link. Creating a session publishes its
 * directory by a rename; removing one renames it away first, never emptying
 * it in place; immutable generation tombstones fence removal and ancestry.
 *
 * A commit file holds its trailer's length and CRC-32: one at a session's
 * tail that is not whole (the disk dropped what was flushed) is moved to
 * `quarantine/` and the commit before it is the head, a warning logged; one
 * before the tail fails with `store.decode`, nothing moved. A move that took
 * another writer's whole commit (published after another handle set the
 * torn one aside) puts it back. A directory with any unsupported layout fails to open with `store.version`; one without hard links, with
 * `store.open`. An open sweeps recognized abandoned marker publications in `staging/`. Claims and tombstones remain permanent.
 *
 * At most two file system calls are in flight per handle, and each must
 * answer within `stallMs` (default 10 s), or the call fails with
 * `store.stalled`; then every call fails at once, until one let through a
 * `stallMs` later answers again. A call that did not answer keeps its slot
 * until it does, so a hung mount holds two of the runtime's worker threads,
 * not all of them, and healthy calls queue for what is left. The time is
 * the caller's Effect `Clock`: commits and heads are stamped with it, so
 * instances sharing the directory need clocks in step. A handle caches at
 * most `CACHE_BOUNDS` (sessions, commit first lines). Each call is a
 * `session_log.<op>` span, with `efferent.session.id` when it names one.
 *
 * @public
 */
export const makeSessionLogFiles = Effect.fnUntraced(function* (root: string, options?: SessionLogFilesOptions): Effect.fn.Return<SessionLog["Service"], SessionLogError, Scope.Scope> {
  const io = options?.io ?? nodeFilesIo
  const stallMs = options?.stallMs ?? sessionFilesDefaults.stallMs
  const known = yield* Ref.make<ReadonlyMap<string, Known>>(new Map())
  /** The sessions whose temporary files this handle swept, at its first commit to each (forgotten past the cache's bound: swept again then). */
  const swept = yield* Ref.make<ReadonlySet<string>>(new Set())

  const sessionsDir = join(root, "sessions")
  const stagingDir = join(root, "staging")
  const keyOf = (id: SessionRef) => JSON.stringify([id.id, id.owner, id.incarnation])
  const dirOf = (id: SessionRef) => join(sessionsDir, id.id, "lives", id.incarnation)
  const claimsDir = (id: ConversationId) => join(sessionsDir, id, "claims")
  const removedPath = (id: SessionRef) => join(dirOf(id), "removed")
  const headerPath = (id: SessionRef) => join(dirOf(id), "header.json")
  const commitsDir = (id: SessionRef) => join(dirOf(id), "commits")
  const commitPath = (id: SessionRef, revision: number) => join(commitsDir(id), revisionFile(revision))
  const nonce = () => PublishNonce.make(randomUUID())
  const staged = (prefix: string, now: number) => join(stagingDir, stagingName(prefix, now, randomUUID()))

  const call = yield* makeBoundedFilesCall(stallMs)

  /** A call whose failure is not the caller's to handle: logged, then let go. */
  const bestEffort = (op: string, path: string, run: () => Promise<void>) => call(op, path, run).pipe(
    Effect.ignore({ log: "Debug", message: `the session directory could not ${op} ${path}; it is left as it is` }),
  )

  /* ── opening ── */

  const openedAt = yield* Clock.currentTimeMillis
  const markerPath = join(root, "store.json")
  const readMarker = call("read", markerPath, () => io.read(markerPath)).pipe(
    Effect.mapError(storeError("store.open", "read store.json")),
    Effect.flatMap((bytes) => Result.match(markerOfText(decoder.decode(bytes)), {
      onFailure: (error) => Effect.fail(decodeError("store.json", error.message)), onSuccess: Effect.succeed,
    })),
  )
  const existing = yield* readMarker.pipe(Effect.map(Option.some), Effect.catchIf(vanished, () => Effect.succeedNone))
  const unsupported = (layout: number) => new SessionLogError({ code: "store.version", message: `the session directory uses unsupported layout ${layout}; configure a fresh store for layout ${FILES_LAYOUT}` })
  if (Option.isSome(existing) && existing.value.layout !== FILES_LAYOUT) return yield* Effect.fail(unsupported(existing.value.layout))
  if (Option.isNone(existing)) {
    const contents = yield* call("list", root, () => io.list(root)).pipe(
      Effect.catchIf((error) => isCode(error, "ENOENT"), () => Effect.succeed<ReadonlyArray<string>>([])),
      Effect.mapError(storeError("store.open", "inspect the new store")),
    )
    if (contents.length > 0) {
      if (contents.some((name) => !["sessions", "staging", "quarantine"].includes(name))) return yield* Effect.fail(unsupported(0))
      const occupied = yield* Effect.forEach(["sessions", "quarantine"], (name) => call("list", join(root, name), () => io.list(join(root, name))).pipe(
        Effect.catchIf((error) => isCode(error, "ENOENT"), () => Effect.succeed<ReadonlyArray<string>>([])), Effect.mapError(storeError("store.open", "inspect an initializing store")),
      ), { concurrency: 1 })
      if (occupied.some((names) => names.length > 0)) return yield* Effect.fail(unsupported(0))
    }
  }
  yield* Effect.forEach([root, sessionsDir, stagingDir, join(root, "quarantine")], (path) =>
    call("mkdir", path, () => io.mkdir(path)), { concurrency: 1, discard: true }).pipe(Effect.mapError(storeError("store.open", "create its folders")))
  if (Option.isNone(existing)) {
    const temporary = staged("store.json", openedAt)
    yield* call("create", temporary, () => io.create(temporary, encoder.encode(`${JSON.stringify({ layout: FILES_LAYOUT })}\n`))).pipe(
      Effect.andThen(call("link", markerPath, () => io.link(temporary, markerPath)).pipe(Effect.catchIf((error) => isCode(error, "EEXIST"), () => Effect.void))),
      Effect.mapError(storeError("store.open", "initialize store.json")),
    )
    yield* bestEffort("unlink", temporary, () => io.unlink(temporary))
    const marker = yield* readMarker
    if (marker.layout !== FILES_LAYOUT) return yield* Effect.fail(unsupported(marker.layout))
  }
  const abandoned = yield* call("list", stagingDir, () => io.list(stagingDir)).pipe(Effect.mapError(storeError("store.open", "list staging files")))
  yield* Effect.forEach(abandoned.filter((name) => isAbandonedStaging(name, openedAt, Math.max(STAGING_SWEEP_MS, 16 * stallMs))), (name) =>
    bestEffort("remove", join(stagingDir, name), () => io.removeTree(join(stagingDir, name))), { concurrency: 1, discard: true })

  /* ── reading a session ── */

  const exists = (path: string) => call("stat", path, () => io.exists(path)).pipe(Effect.mapError(storeError("store.io", "look a file up")))
  const referenceOf = (record: HeaderRecord): SessionRef => ({ id: record.header.id, owner: record.header.owner, incarnation: incarnationOf(record) })
  const decodeHeader = (what: string) => (bytes: Uint8Array) => Result.match(headerOfText(decoder.decode(bytes)), {
    onFailure: (error) => Effect.fail(decodeError(what, error.message)), onSuccess: Effect.succeed,
  })
  const latestClaim = (id: ConversationId): Effect.Effect<{ readonly generation: number; readonly header: HeaderRecord }, SessionMissing | SessionLogError> => Effect.gen(function* () {
    const names = yield* call("list", claimsDir(id), () => io.list(claimsDir(id))).pipe(
      Effect.catchIf((error) => isCode(error, "ENOENT", "ENOTDIR"), () => Effect.fail(new SessionMissing({ session: id }))),
      Effect.mapError((error) => error._tag === "SessionMissing" ? error : storeError("store.io", "list session generations")(error)),
    )
    const generation = names.reduce((highest, name) => /^\d+\.json$/.test(name) ? Math.max(highest, Number(name.slice(0, -5))) : highest, 0)
    if (generation === 0) return yield* Effect.fail(new SessionMissing({ session: id }))
    const path = join(claimsDir(id), `${generation}.json`)
    const header = yield* call("read", path, () => io.read(path)).pipe(Effect.mapError(storeError("store.io", "read a generation claim")), Effect.flatMap(decodeHeader(`generation ${generation} of session ${id}`)))
    return { generation, header }
  })
  const headerOf = (id: SessionRef): Effect.Effect<HeaderRecord, SessionMissing | SessionLogError> => Effect.gen(function* () {
    const missing = () => Effect.fail(new SessionMissing({ session: id.id }))
    if (yield* exists(removedPath(id))) return yield* missing()
    const record = yield* call("read", headerPath(id), () => io.read(headerPath(id))).pipe(
      Effect.catchIf((error) => isCode(error, "ENOENT", "ENOTDIR"), missing),
      Effect.mapError((error) => error._tag === "SessionMissing" ? error : storeError("store.io", "read a session header")(error)), Effect.flatMap(decodeHeader(`the header of session ${describe(id)}`)),
    )
    if (record.header.id !== id.id || record.header.owner !== id.owner || incarnationOf(record) !== id.incarnation) return yield* missing()
    const parent = record.header.parent
    if (Option.isSome(parent)) yield* Effect.suspend(() => headerOf(parent.value)).pipe(Effect.asVoid)
    return record
  })
  const resolveRef = (id: ConversationId) => latestClaim(id).pipe(Effect.flatMap(({ header }) => headerOf(referenceOf(header)).pipe(Effect.map(referenceOf))))

  /**
   * A missing payload belongs to a removed generation when its immutable
   * header/tombstone says so. Otherwise retain the IO failure's cause.
   */
  const goneOr = (id: SessionRef, what: string) => (error: Failed): Effect.Effect<never, SessionMissing | SessionLogError> =>
    isCode(error, "ENOENT", "ENOTDIR")
      ? headerOf(id).pipe(Effect.andThen(Effect.fail(storeError("store.io", what)(error))))
      : Effect.fail(storeError("store.io", what)(error))

  /** The highest revision whose file exists, from `from`: each later name is tried until one is missing (a newer commit of another handle). */
  const probeForward = (id: SessionRef, from: number): Effect.Effect<number, SessionLogError> =>
    exists(commitPath(id, from + 1)).pipe(Effect.flatMap((found) => found ? probeForward(id, from + 1) : Effect.succeed(from)))

  /** The highest revision in the session's commits, from its listing. */
  const listedRevision = (id: SessionRef) => call("list", commitsDir(id), () => io.list(commitsDir(id))).pipe(
    Effect.catch(goneOr(id, "list a session's commits")),
    Effect.map((names) => names.reduce((highest, name) => Option.match(revisionOfFile(name), { onNone: () => highest, onSome: (revision) => Math.max(highest, revision) }), 0)),
  )

  const commitBytes = (id: SessionRef, revision: number) =>
    call("read", commitPath(id, revision), () => io.read(commitPath(id, revision))).pipe(Effect.catch(goneOr(id, "read a commit")))

  /** A whole commit file, or `store.decode`: damage before the tail is not repaired. */
  const wholeCommit = (id: SessionRef, revision: number): Effect.Effect<CommitRecord, SessionMissing | SessionLogError> =>
    commitBytes(id, revision).pipe(Effect.flatMap((bytes) => Result.match(decodeCommit(bytes), {
      onFailure: (damage) => Effect.fail(decodeError(`commit ${revision} of session ${describe(id)}`, `${damage}; it is not the session's last, so it is not repaired`)),
      onSuccess: Effect.succeed,
    })))

  /**
   * Set a torn tail aside, its bytes kept, so the commit before it is the
   * head again; another handle may have done it first. The move goes by
   * name, so what it moved is read back: when it is not the torn file read
   * (another handle set that aside, and a writer published the revision
   * again), it is put back by an exclusive link.
   */
  const quarantine = (id: SessionRef, revision: number, torn: Uint8Array, damage: string): Effect.Effect<SetAside, SessionLogError> => Effect.gen(function* () {
    const folder = join(root, "quarantine", id.id, id.incarnation)
    yield* call("mkdir", folder, () => io.mkdir(folder)).pipe(Effect.mapError(storeError("store.io", "create the quarantine")))
    const aside = join(folder, `${revisionFile(revision)}.${randomUUID()}`)
    const moved = yield* call("rename", commitPath(id, revision), () => io.rename(commitPath(id, revision), aside)).pipe(
      Effect.as(true),
      Effect.catchIf((error) => isCode(error, "ENOENT"), () => Effect.succeed(false)),
      Effect.mapError(storeError("store.io", "set a torn commit aside")),
    )
    if (!moved) return "aside"
    const taken = yield* call("read", aside, () => io.read(aside)).pipe(Effect.mapError(storeError("store.io", "read a commit set aside")))
    const annotated = Effect.annotateLogs({ "efferent.session.id": id.id, "efferent.session.incarnation": id.incarnation })
    if (sameBytes(taken, torn)) {
      yield* Effect.logWarning(`a torn commit at the tail of the session (revision ${revision}, ${damage}) was moved to ${aside}; the commit before it is the session's head`).pipe(annotated)
      return "aside"
    }
    const restored = yield* call("link", commitPath(id, revision), () => io.link(aside, commitPath(id, revision))).pipe(
      Effect.as(true),
      Effect.catchIf((error) => isCode(error, "EEXIST"), () => Effect.succeed(false)),
      Effect.mapError(storeError("store.io", "put a commit back")),
    )
    if (restored) {
      yield* bestEffort("unlink", aside, () => io.unlink(aside))
      return "restored"
    }
    yield* Effect.logError(`revision ${revision} of the session, published again after a torn one was set aside, was moved to ${aside} and could not be put back: a third writer took the revision; its bytes are kept there`).pipe(annotated)
    return "restored"
  })

  const tailOfRecord = (record: CommitRecord): Tail => ({ revision: record.meta.revision, seq: record.meta.last, at: record.meta.at, state: record.state })

  /** The tail at `revision`, read and checked: a torn one is set aside once, and the one before it must be whole. */
  const tailAt = (id: SessionRef, header: HeaderRecord, revision: number, repaired: boolean): Effect.Effect<{ readonly tail: Tail; readonly meta: Option.Option<CommitMeta> }, SessionMissing | SessionLogError> => {
    if (revision === 0) return Effect.succeed({ tail: { revision: 0, seq: 0, at: header.createdNow, state: header.state }, meta: Option.none() })
    return commitBytes(id, revision).pipe(Effect.flatMap((bytes) => {
      const decoded = decodeCommit(bytes)
      return Match.valueTags(tailVerdict(decoded, !repaired), {
        Intact: () => Result.match(decoded, {
          onFailure: () => Effect.fail(decodeError(`commit ${revision} of session ${describe(id)}`, "unreadable")),
          onSuccess: (record) => Effect.succeed({ tail: tailOfRecord(record), meta: Option.some(record.meta) }),
        }),
        Quarantine: ({ damage }) => quarantine(id, revision, bytes, damage).pipe(Effect.flatMap((outcome) => outcome === "aside"
          ? tailAt(id, header, revision - 1, true)
          : tailAt(id, header, revision, repaired))),
        Corrupt: ({ damage }) => Effect.fail(decodeError(`commit ${revision} of session ${describe(id)}`, `${damage}, below a torn tail`)),
      })
    }))
  }

  const remember = (id: SessionRef, headerNonce: PublishNonce, tail: Tail, metas: Iterable<CommitMeta>) => Ref.update(known, (all) => {
    const before = Option.filter(Option.fromNullishOr(all.get(keyOf(id))), (entry) => entry.nonce === headerNonce)
    const kept = Option.match(before, { onNone: () => new Map<number, CommitMeta>(), onSome: (entry) => new Map(entry.metas) })
    Array.from(metas).forEach((meta) => kept.set(meta.revision, meta))
    return cacheWith(all, keyOf(id), { nonce: headerNonce, tail, metas: kept })
  })

  /** The session's header and tail as they stand: from what this handle knew (if the session is the same one), then any later commit. */
  const currentOnce = (id: SessionRef): Effect.Effect<{ readonly header: HeaderRecord; readonly tail: Tail }, SessionMissing | SessionLogError> => Effect.gen(function* () {
    const header = yield* headerOf(id)
    const before = Option.filter(Option.fromNullishOr((yield* Ref.get(known)).get(keyOf(id))), (entry) => entry.nonce === header.nonce)
    const start = yield* Option.match(before, {
      onNone: () => listedRevision(id),
      onSome: (entry) => entry.tail.revision === 0
        ? Effect.succeed(0)
        : exists(commitPath(id, entry.tail.revision)).pipe(Effect.flatMap((still) => still ? Effect.succeed(entry.tail.revision) : listedRevision(id))),
    })
    const revision = yield* probeForward(id, start)
    const same = Option.filter(before, (entry) => entry.tail.revision === revision)
    if (Option.isSome(same)) {
      yield* Ref.update(known, (all) => cacheWith(all, keyOf(id), same.value))
      return { header, tail: same.value.tail }
    }
    const found = yield* tailAt(id, header, revision, false)
    yield* remember(id, header.nonce, found.tail, Option.toArray(found.meta))
    return { header, tail: found.tail }
  })

  /**
   * `currentOnce`, read once more when a file it found vanished under it (a
   * tail another handle set aside, a session removed or created again): a
   * session removed meanwhile is `SessionMissing`, never `store.io`.
   */
  const current = (id: SessionRef) => currentOnce(id).pipe(Effect.catchIf(vanished, () => currentOnce(id)))

  // A head's own copies: what a caller does with a returned header or state never reaches what this handle keeps.
  const headOf = (header: HeaderRecord, tail: Tail, now: number): SessionHead => ({
    header: { ...header.header, meta: structuredClone(header.header.meta) }, incarnation: incarnationOf(header), seq: tail.seq, revision: tail.revision, state: structuredClone(tail.state), updatedAt: tail.at, now,
  })

  /** A commit's first line, which says what it holds, read from the file's start (the whole commit when the line is not whole there). */
  const metaOfFile = (id: SessionRef, revision: number): Effect.Effect<CommitMeta, SessionMissing | SessionLogError> => Effect.gen(function* () {
    const start = yield* call("read", commitPath(id, revision), () => io.readStart(commitPath(id, revision), META_PREFIX)).pipe(Effect.catch(goneOr(id, "read a commit")))
    const text = decoder.decode(start)
    const line = text.slice(0, Math.max(0, text.indexOf("\n")))
    return yield* Option.match(metaOfLine(line), {
      onSome: Effect.succeed,
      onNone: () => wholeCommit(id, revision).pipe(Effect.map((record) => record.meta)),
    })
  })

  const eventOf = (id: ConversationId, at: number) => (event: CommitEvent): SessionLogEvent => ({
    session: id, seq: event.seq, turn: Option.fromNullishOr(event.turn), kind: event.kind, at, data: event.data,
  })

  /* ── publishing ── */

  /**
   * Link a written commit to its revision's name. Any failure is settled by
   * what the name holds: this commit (its nonce: the link landed, whatever
   * it answered), another writer's (taken), or nothing; a session that is
   * gone answers missing.
   */
  const publish = (id: SessionRef, temporary: string, revision: number, ours: PublishNonce): Effect.Effect<Published, SessionLogError> =>
    call("link", commitPath(id, revision), () => io.link(temporary, commitPath(id, revision))).pipe(
      Effect.as<Published>({ _tag: "Published" }),
      Effect.catch((linkError) => call("read", commitPath(id, revision), () => io.read(commitPath(id, revision))).pipe(
        Effect.map((bytes): Published => Result.match(decodeCommit(bytes), {
          onSuccess: (record) => record.meta.nonce === ours ? { _tag: "Published" } : { _tag: "Taken" },
          onFailure: () => ({ _tag: "Taken" }),
        })),
        Effect.catchIf((error) => isCode(error, "ENOENT", "ENOTDIR"), () => headerOf(id).pipe(Effect.as(true), Effect.catchTag("SessionMissing", () => Effect.succeed(false)),
          Effect.flatMap((there) => there ? Effect.fail(storeError("store.io", "publish a commit")(linkError)) : Effect.succeed<Published>({ _tag: "Missing" })),
        )),
        Effect.mapError((error) => error._tag === "SessionLogError" ? error : storeError("store.io", "read a commit back")(error)),
      )),
    )

  /**
   * The temporary files of commits that can never be published, since their
   * revision is taken (by `revision` or before): left by a writer that
   * stopped between writing a commit and linking it, or between linking it
   * and removing it. Once per session and handle, at its first commit.
   */
  const sweepTemporaries = (id: SessionRef, revision: number) => Effect.gen(function* () {
    const first = yield* Ref.modify(swept, (done): [boolean, ReadonlySet<string>] => done.has(keyOf(id))
      ? [false, done]
      : [true, done.size >= CACHE_BOUNDS.sessions ? new Set([keyOf(id)]) : new Set(done).add(keyOf(id))])
    if (!first) return
    const folder = join(dirOf(id), "tmp")
    const names = yield* call("list", folder, () => io.list(folder)).pipe(
      Effect.tapError((error) => Effect.logDebug(`the temporary files of a session could not be listed (${error._tag}); they are swept at a later commit`)),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    )
    const dead = names.filter((name) => Option.exists(revisionOfTemporary(name), (written) => written <= revision))
    yield* Effect.forEach(dead, (name) => bestEffort("unlink", join(folder, name), () => io.unlink(join(folder, name))), { concurrency: 1, discard: true })
  })

  /** Tombstone an immutable generation before deleting only its payload folders. */
  const discard = (id: SessionRef) => Effect.gen(function* () {
    yield* call("create", removedPath(id), () => io.create(removedPath(id), encoder.encode("removed\n"))).pipe(
      Effect.catchIf((error) => isCode(error, "EEXIST"), () => Effect.void), Effect.mapError(storeError("store.io", "remove a session generation")),
    )
    yield* Ref.update(known, (all) => { const rest = new Map(all); rest.delete(keyOf(id)); return rest })
    yield* bestEffort("remove", commitsDir(id), () => io.removeTree(commitsDir(id)))
    yield* bestEffort("remove", join(dirOf(id), "tmp"), () => io.removeTree(join(dirOf(id), "tmp")))
  })
  const childrenOf = (parent: SessionRef): Effect.Effect<ReadonlyArray<SessionRef>, SessionLogError> => Effect.gen(function* () {
    const names = yield* call("list", sessionsDir, () => io.list(sessionsDir)).pipe(Effect.mapError(storeError("store.io", "list the sessions")))
    const children = yield* Effect.forEach(names.flatMap((name) => Option.toArray(sessionIdOf(name))), (id) => latestClaim(id).pipe(
      Effect.map(({ header }) => Option.exists(header.header.parent, (lineage) => lineage.id === parent.id && lineage.owner === parent.owner && lineage.incarnation === parent.incarnation) ? [referenceOf(header)] : []),
      Effect.catchTag("SessionMissing", () => Effect.succeed<ReadonlyArray<SessionRef>>([])),
    ), { concurrency: 2 })
    return children.flat()
  })
  const removeTree = (id: SessionRef): Effect.Effect<void, SessionLogError> => Effect.gen(function* () {
    yield* discard(id)
    yield* Effect.forEach(yield* childrenOf(id), removeTree, { concurrency: 1, discard: true })
  })

  return SessionLog.of({
    create: Effect.fn("session_log.create")(function* ({ header, state }: { readonly header: SessionHeader; readonly state: JsonObject }) {
      const meta = yield* storedJson(header.meta).pipe(Effect.mapError((cause) => new SessionLogError({ code: "store.encode", message: "the header is not JSON", cause })))
      const initial = yield* storedJson(state).pipe(Effect.mapError((cause) => new SessionLogError({ code: "store.encode", message: "the initial state is not JSON", cause })))
      const previous = yield* latestClaim(header.id).pipe(Effect.map(Option.some), Effect.catchTag("SessionMissing", () => Effect.succeedNone))
      if (Option.isSome(previous)) {
        const active = yield* headerOf(referenceOf(previous.value.header)).pipe(Effect.as(true), Effect.catchTag("SessionMissing", () => Effect.succeed(false)))
        if (active) return yield* Effect.fail(new SessionExists({ session: header.id }))
      }
      if (Option.isSome(header.parent)) {
        if (header.parent.value.owner !== header.owner) return yield* Effect.fail(new SessionMissing({ session: header.parent.value.id }))
        yield* headerOf(header.parent.value)
      }
      const now = yield* Clock.currentTimeMillis
      const record: HeaderRecord = { header: { ...header, meta }, state: initial, createdNow: now, nonce: nonce() }
      const reference = referenceOf(record)
      const text = yield* Result.match(headerText(record), { onFailure: (cause) => Effect.fail(new SessionLogError({ code: "store.encode", message: "the header does not encode", cause })), onSuccess: Effect.succeed })
      const directory = dirOf(reference)
      yield* Effect.forEach([claimsDir(header.id), join(directory, "commits"), join(directory, "tmp")], (path) => call("mkdir", path, () => io.mkdir(path)), { concurrency: 1, discard: true }).pipe(Effect.mapError(storeError("store.io", "stage a new generation")))
      yield* call("create", headerPath(reference), () => io.create(headerPath(reference), encoder.encode(text))).pipe(Effect.mapError(storeError("store.io", "write a new header")))
      const generation = Option.match(previous, { onNone: () => 1, onSome: (value) => value.generation + 1 })
      const claim = join(claimsDir(header.id), `${generation}.json`)
      const published = yield* call("link", claim, () => io.link(headerPath(reference), claim)).pipe(
        Effect.as(true),
        Effect.catch((error) => call("read", claim, () => io.read(claim)).pipe(Effect.flatMap(decodeHeader(`generation ${generation} of session ${header.id}`)), Effect.map((found) => found.nonce === record.nonce), Effect.mapError(() => storeError("store.io", "publish the new generation")(error)))),
      )
      if (!published) {
        yield* bestEffort("remove", directory, () => io.removeTree(directory))
        return yield* Effect.fail(new SessionExists({ session: header.id }))
      }
      if (Option.isSome(header.parent)) yield* headerOf(header.parent.value).pipe(Effect.tapError(() => discard(reference)))
      const tail: Tail = { revision: 0, seq: 0, at: now, state: initial }
      yield* remember(reference, record.nonce, tail, [])
      return headOf(record, tail, now)
    }, (effect, input) => onSession(effect, input.header.id)),

    head: Effect.fn("session_log.head")(function* (id: ConversationId) {
      const reference = yield* resolveRef(id)
      const { header, tail } = yield* current(reference)
      return headOf(header, tail, yield* Clock.currentTimeMillis)
    }, onSession),

    list: Effect.fn("session_log.list")(function* (query: SessionListQuery) {
      const now = yield* Clock.currentTimeMillis
      const names = yield* call("list", sessionsDir, () => io.list(sessionsDir)).pipe(Effect.mapError(storeError("store.io", "list the sessions")))
      const heads = yield* Effect.forEach(names.flatMap((name) => Option.toArray(sessionIdOf(name))), (name) => resolveRef(name).pipe(Effect.flatMap(headerOf),
        Effect.flatMap((record) => inListing(record, query)
          ? current(referenceOf(record)).pipe(Effect.map(({ header, tail }) => Option.some(headOf(header, tail, now))))
          : Effect.succeedNone),
        // A session removed while it was listed is not in the listing.
        Effect.catchTag("SessionMissing", () => Effect.succeedNone),
      ), { concurrency: 2 })
      return page(heads.flatMap(Option.toArray), query)
    }),

    read: Effect.fn("session_log.read")(function* (id: SessionRef, query: SessionReadQuery) {
      const { header, tail } = yield* current(id)
      const limit = Option.match(query.limit, { onNone: () => Number.POSITIVE_INFINITY, onSome: (value) => Math.max(0, value) })
      const wanted = (kind: string) => query.kinds.length === 0 || query.kinds.includes(kind)
      // From the end, commits are read newest first and the read stops once it holds `limit` events.
      const latest = query.from === "end"
      // The metas this handle read before, and the ones this read reads: kept once, when it is done.
      const cached = Option.match(Option.filter(Option.fromNullishOr((yield* Ref.get(known)).get(keyOf(id))), (entry) => entry.nonce === header.nonce), {
        onNone: (): ReadonlyMap<number, CommitMeta> => new Map(),
        onSome: (entry) => entry.metas,
      })
      const fresh = new Map<number, CommitMeta>()
      const metaAt = (revision: number) => Option.match(Option.fromNullishOr(cached.get(revision)), {
        onSome: (meta) => Effect.succeed(meta),
        onNone: () => metaOfFile(id, revision).pipe(Effect.tap((meta) => Effect.sync(() => fresh.set(revision, meta)))),
      })
      const chunks: Array<ReadonlyArray<SessionLogEvent>> = []
      let count = 0
      for (let revision = latest ? tail.revision : 1; revision >= 1 && revision <= tail.revision && count < limit; revision += latest ? -1 : 1) {
        const meta = yield* metaAt(revision)
        if (meta.last <= query.after || (query.through !== undefined && meta.first > query.through) || meta.first > meta.last || !meta.kinds.some(wanted)) continue
        const record = yield* wholeCommit(id, revision)
        const matched = record.events.filter((event) => event.seq > query.after && (query.through === undefined || event.seq <= query.through) && wanted(event.kind)).map(eventOf(id.id, record.meta.at))
        const remaining = limit - count
        const kept = latest ? matched.slice(Math.max(0, matched.length - remaining)) : matched.slice(0, remaining)
        chunks.push(kept)
        count += kept.length
      }
      const events = (latest ? chunks.reverse() : chunks).flat()
      if (fresh.size > 0) yield* Ref.update(known, (all) => Option.match(Option.filter(Option.fromNullishOr(all.get(keyOf(id))), (entry) => entry.nonce === header.nonce), {
        onNone: () => all,
        onSome: (entry) => cacheWith(all, keyOf(id), { ...entry, metas: new Map([...entry.metas, ...fresh]) }),
      }))
      return events
    }, (effect, reference) => onSession(effect, reference.id)),

    commit: Effect.fn("session_log.commit")(function* (id: SessionRef, commit: SessionCommit) {
      const data = yield* Effect.forEach(commit.events, (draft) => storedJson(draft.data).pipe(
        Effect.mapError((error) => new SessionLogError({ code: "store.encode", message: `the data is not JSON: ${error.message}`, cause: error })),
      ), { concurrency: 1 })
      const { header, tail } = yield* current(id)
      // A session removed and created again under its id is another incarnation: missing to a writer of the one before.
      if (tail.revision !== commit.expect) return yield* Effect.fail(new RevisionConflict({ session: id.id, expected: commit.expect, actual: tail.revision }))
      const at = yield* Clock.currentTimeMillis
      if (Option.isSome(commit.notAfter) && at > commit.notAfter.value) return yield* Effect.fail(new LeaseExpired({ session: id.id, notAfter: commit.notAfter.value, now: at }))
      const revision = tail.revision + 1
      const events: ReadonlyArray<CommitEvent> = commit.events.map((draft, index) => ({
        seq: tail.seq + index + 1, turn: Option.getOrNull(draft.turn), kind: draft.kind, data: data[index] ?? {},
      }))
      const ours = nonce()
      const meta: CommitMeta = {
        layout: FILES_LAYOUT, session: id.id, revision, first: tail.seq + 1, last: tail.seq + events.length, at,
        kinds: [...new Set(events.map((event) => event.kind))], nonce: ours,
      }
      // The state as it is stored and read back (JSON): the caller's object is never kept.
      const state = yield* Option.match(commit.state, {
        onNone: () => Effect.succeed(tail.state),
        onSome: (next) => storedJson(next).pipe(Effect.mapError((error) => new SessionLogError({ code: "store.encode", message: `the state is not JSON: ${error.message}`, cause: error }))),
      })
      const temporary = join(dirOf(id), "tmp", `${revisionFile(revision)}.${ours}`)
      // Written, flushed and published as one: an interrupt waits for the outcome (each call is bounded by `stallMs`).
      const published = yield* Effect.uninterruptible(Effect.gen(function* () {
        const written = yield* call("create", temporary, () => io.create(temporary, encodeCommit({ meta, state, events }))).pipe(
          Effect.as(true),
          Effect.catchIf((error) => isCode(error, "ENOENT", "ENOTDIR"), () => Effect.succeed(false)),
          Effect.mapError(storeError("store.io", "write a commit")),
        )
        if (!written) return { _tag: "Missing" } satisfies Published
        // The immutable generation and its tombstone fence publication. A new
        // incarnation uses another payload directory, even under the same id.
        const same = yield* headerOf(id).pipe(Effect.map((found) => found.nonce === header.nonce), Effect.catchTag("SessionMissing", () => Effect.succeed(false)))
        if (!same) {
          yield* bestEffort("unlink", temporary, () => io.unlink(temporary))
          return { _tag: "Replaced" } satisfies Published
        }
        // The lease's end again, right before the link: a write that took past it publishes nothing.
        const linking = yield* Clock.currentTimeMillis
        if (Option.isSome(commit.notAfter) && linking > commit.notAfter.value) {
          yield* bestEffort("unlink", temporary, () => io.unlink(temporary))
          return { _tag: "Expired", notAfter: commit.notAfter.value, now: linking } satisfies Published
        }
        const outcome = yield* publish(id, temporary, revision, ours)
        yield* bestEffort("unlink", temporary, () => io.unlink(temporary))
        if (outcome._tag === "Published") yield* bestEffort("sync", commitsDir(id), () => io.syncDirectory(commitsDir(id)))
        return outcome
      }))
      return yield* Match.valueTags(published, {
        Published: (): Effect.Effect<SessionCommitted, RevisionConflict | SessionMissing | SessionLogError | LeaseExpired> => remember(id, header.nonce, { revision, seq: meta.last, at, state }, [meta]).pipe(
          Effect.andThen(sweepTemporaries(id, revision)),
          Effect.as({ revision, seq: meta.last, events: events.map(eventOf(id.id, at)), at }),
        ),
        Taken: () => current(id).pipe(Effect.flatMap((after) => Effect.fail(new RevisionConflict({ session: id.id, expected: commit.expect, actual: after.tail.revision })))),
        Missing: () => Effect.fail(new SessionMissing({ session: id.id })),
        Expired: (expired) => Effect.fail(new LeaseExpired({ session: id.id, notAfter: expired.notAfter, now: expired.now })),
        // Named, the incarnation is gone; unnamed, the commit was planned on a session since replaced: plan again.
        Replaced: () => Effect.fail(new SessionMissing({ session: id.id })),
      })
    }, (effect, reference) => onSession(effect, reference.id)),

    remove: Effect.fn("session_log.remove")(function* (id: SessionRef) {
      yield* headerOf(id)
      yield* removeTree(id)
    }, (effect, reference) => onSession(effect, reference.id)),
  })
})

/** The session log in a directory (see `makeSessionLogFiles`). @public */
export const SessionLogFilesLive = (root: string, options?: SessionLogFilesOptions): Layer.Layer<SessionLog, SessionLogError> =>
  Layer.effect(SessionLog, makeSessionLogFiles(root, options))
