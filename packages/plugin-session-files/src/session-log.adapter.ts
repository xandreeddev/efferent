import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { Cause, Clock, Effect, Layer, Match, Option, Ref, Result, Schema, Semaphore } from "effect"
import type { Scope } from "effect"
import {
  ConversationId,
  errorCodeOf,
  LeaseExpired,
  reasonOf,
  RevisionConflict,
  SessionExists,
  SessionLog,
  SessionLogError,
  SessionMissing,
  storedJson,
} from "@xandreed/core"
import type { JsonObject, SessionCommit, SessionCommitted, SessionHead, SessionHeader, SessionListQuery, SessionLogEvent, SessionReadQuery } from "@xandreed/core"
import { nodeFilesIo } from "./files-io.adapter.js"
import type { FilesIo } from "./files-io.adapter.js"
import { FILES_LAYOUT, FileStoreIo, FileStoreStalled, PublishNonce, sessionFilesDefaults } from "./session-files.entity.js"
import type { CommitEvent, CommitMeta, CommitRecord, HeaderRecord, StoreHealth } from "./session-files.entity.js"
import {
  admitCall,
  afterCall,
  decodeCommit,
  encodeCommit,
  headerOfText,
  headerText,
  inListing,
  isSessionDirectory,
  markerOfText,
  metaOfLine,
  page,
  revisionFile,
  revisionOfFile,
  revisionOfTemporary,
  tailVerdict,
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

const META_PREFIX = 65_536
/** A name under `sessions/` as the session's id; none for any other name (`isSessionDirectory`). */
const sessionIdOf = (name: string): Option.Option<ConversationId> =>
  isSessionDirectory(name) ? Schema.decodeUnknownOption(ConversationId)(name) : Option.none()
const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** A promise that settles within `ms`: its own outcome, or `stalled` once the time is up (the call itself may still finish later). */
const withinDeadline = <A>(promise: Promise<A>, ms: number, stalled: unknown): Promise<A> => new Promise<A>((resolve, reject) => {
  const timer = setTimeout(() => reject(stalled), ms)
  promise.then(
    (value) => { clearTimeout(timer); resolve(value) },
    (error: unknown) => { clearTimeout(timer); reject(error) },
  )
})

const isCode = (error: Failed, ...codes: ReadonlyArray<string>): boolean =>
  error._tag === "FileStoreIo" && Option.exists(errorCodeOf(error.cause), (code) => codes.includes(code))

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

/**
 * The session log as files in a directory, local or on a network mount
 * (NFS), on Node 24 and Bun: one immutable file per commit, written to a
 * temporary file, flushed, then published by an exclusive hard link to its
 * revision's name. Exactly one writer wins each revision, so a commit is a
 * compare-and-swap without a lock: no handle waits on another, and a handle
 * whose process stopped blocks nobody. A publish whose answer may be wrong
 * (a network file system's retransmitted link) is settled by reading the
 * published file's nonce. Creating a session publishes its directory by a
 * rename; removing one renames it away first, never emptying it in place.
 *
 * A commit file holds its trailer's length and CRC-32: one at a session's
 * tail that is not whole (the disk dropped what was flushed) is moved to
 * `quarantine/` and the commit before it is the head, a warning logged; one
 * before the tail fails with `store.decode`, nothing moved. A directory
 * whose layout a newer release wrote fails to open with `store.version`;
 * one without hard links, with `store.open`.
 *
 * At most two file system calls are in flight per handle, and each must
 * answer within `stallMs` (default 10 s), or the call fails with
 * `store.stalled`; then every call fails at once, until one let through a
 * `stallMs` later answers again. A hung mount thus holds two of the
 * runtime's worker threads, not all of them. The time is the caller's
 * Effect `Clock`: commits and heads are stamped with it, so instances
 * sharing the directory need clocks in step. Each call is a
 * `session_log.<op>` span, with `efferent.session.id` when it names one.
 *
 * @public
 */
export const makeSessionLogFiles = Effect.fnUntraced(function* (root: string, options?: SessionLogFilesOptions): Effect.fn.Return<SessionLog["Service"], SessionLogError, Scope.Scope> {
  const io = options?.io ?? nodeFilesIo
  const stallMs = options?.stallMs ?? sessionFilesDefaults.stallMs
  const permits = yield* Semaphore.make(2)
  const health = yield* Ref.make<StoreHealth>({ _tag: "Healthy" })
  const known = yield* Ref.make<ReadonlyMap<string, Known>>(new Map())
  /** The sessions whose temporary files this handle swept, at its first commit to each. */
  const swept = yield* Ref.make<ReadonlySet<string>>(new Set())

  const sessionsDir = join(root, "sessions")
  const dirOf = (id: string) => join(sessionsDir, id)
  const headerPath = (id: string) => join(dirOf(id), "header.json")
  const commitsDir = (id: string) => join(dirOf(id), "commits")
  const commitPath = (id: string, revision: number) => join(commitsDir(id), revisionFile(revision))
  const nonce = () => PublishNonce.make(randomUUID())

  /** One file system call: admitted by the store's health, one of two in flight, settled within `stallMs`. */
  const call = <A>(op: string, path: string, run: () => Promise<A>): Effect.Effect<A, Failed> => Effect.gen(function* () {
    const admitted = yield* Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Ref.modify(health, (current) => admitCall(current, now, stallMs))))
    if (!admitted) return yield* Effect.fail(new FileStoreStalled({ op, path, ms: stallMs }))
    const stalled = new FileStoreStalled({ op, path, ms: stallMs })
    const settle = (answered: boolean) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Ref.update(health, (current) => afterCall(current, answered, now))))
    return yield* permits.withPermits(1)(Effect.tryPromise({
      try: () => withinDeadline(run(), stallMs, stalled),
      catch: (error): Failed => error === stalled ? stalled : new FileStoreIo({ op, path, cause: error }),
    })).pipe(
      Effect.tap(() => settle(true)),
      Effect.tapError((error) => settle(error._tag === "FileStoreIo")),
    )
  })

  /** A call whose failure is not the caller's to handle: logged, then let go. */
  const bestEffort = (op: string, path: string, run: () => Promise<void>) => call(op, path, run).pipe(
    Effect.ignore({ log: "Debug", message: `the session directory could not ${op} ${path}; it is left as it is` }),
  )

  /* ── opening ── */

  yield* Effect.forEach([root, sessionsDir, join(root, "staging"), join(root, "trash"), join(root, "quarantine")], (path) =>
    call("mkdir", path, () => io.mkdir(path)), { concurrency: 1, discard: true }).pipe(Effect.mapError(storeError("store.open", "create its folders")))

  // A link from a file of its own: a directory without hard links cannot hold this store.
  const probe = join(root, "staging", `link-probe.${randomUUID()}`)
  yield* call("create", probe, () => io.create(probe, encoder.encode("probe\n"))).pipe(Effect.mapError(storeError("store.open", "write a file")))
  yield* call("link", probe, () => io.link(probe, `${probe}.linked`)).pipe(Effect.mapError((error) => isCode(error, "EPERM", "EOPNOTSUPP", "ENOTSUP", "ENOSYS", "EXDEV")
    ? new SessionLogError({ code: "store.open", message: `the session directory ${root} does not support hard links, which this store needs to publish a commit exclusively` })
    : storeError("store.open", "link a file")(error)))
  yield* bestEffort("unlink", probe, () => io.unlink(probe))
  yield* bestEffort("unlink", `${probe}.linked`, () => io.unlink(`${probe}.linked`))

  // The layout: written once, by a link that only one opener wins; a later layout than this release's is left alone.
  const markerPath = join(root, "store.json")
  const readMarker = call("read", markerPath, () => io.read(markerPath)).pipe(
    Effect.mapError(storeError("store.open", "read store.json")),
    Effect.flatMap((bytes) => Result.match(markerOfText(decoder.decode(bytes)), {
      onFailure: (error) => Effect.fail(decodeError("store.json", error.message)),
      onSuccess: Effect.succeed,
    })),
  )
  const markerTemp = join(root, "staging", `store.json.${randomUUID()}`)
  yield* call("create", markerTemp, () => io.create(markerTemp, encoder.encode(`${JSON.stringify({ layout: FILES_LAYOUT })}\n`))).pipe(
    Effect.andThen(call("link", markerPath, () => io.link(markerTemp, markerPath)).pipe(Effect.catchIf((error) => isCode(error, "EEXIST"), () => Effect.void))),
    Effect.mapError(storeError("store.open", "write store.json")),
  )
  yield* bestEffort("unlink", markerTemp, () => io.unlink(markerTemp))
  const marker = yield* readMarker
  if (marker.layout > FILES_LAYOUT) {
    return yield* Effect.fail(new SessionLogError({
      code: "store.version",
      message: `the session directory is at layout ${marker.layout}, written by a newer release; this release reads up to layout ${FILES_LAYOUT}`,
    }))
  }
  // Removed sessions renamed away, left by a process that stopped before deleting them.
  const trashed = yield* call("list", join(root, "trash"), () => io.list(join(root, "trash"))).pipe(
    Effect.tapError((error) => Effect.logDebug(`the session directory's trash could not be listed (${error._tag}); it is swept at the next open`)),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  )
  yield* Effect.forEach(trashed, (name) => bestEffort("remove", join(root, "trash", name), () => io.removeTree(join(root, "trash", name))), { concurrency: 1, discard: true })

  /* ── reading a session ── */

  const headerOf = (id: ConversationId): Effect.Effect<HeaderRecord, SessionMissing | SessionLogError> =>
    call("read", headerPath(id), () => io.read(headerPath(id))).pipe(
      Effect.catchIf((error) => isCode(error, "ENOENT", "ENOTDIR"), () => Effect.fail(new SessionMissing({ session: id }))),
      Effect.mapError((error) => error._tag === "SessionMissing" ? error : storeError("store.io", "read a session's header")(error)),
      Effect.flatMap((bytes) => Result.match(headerOfText(decoder.decode(bytes)), {
        onFailure: (error) => Effect.fail(decodeError(`the header of session ${id}`, error.message)),
        onSuccess: Effect.succeed,
      })),
    )

  const exists = (path: string) => call("stat", path, () => io.exists(path)).pipe(Effect.mapError(storeError("store.io", "look a file up")))

  /** The highest revision whose file exists, from `from`: each later name is tried until one is missing (a newer commit of another handle). */
  const probeForward = (id: ConversationId, from: number): Effect.Effect<number, SessionLogError> =>
    exists(commitPath(id, from + 1)).pipe(Effect.flatMap((found) => found ? probeForward(id, from + 1) : Effect.succeed(from)))

  /** The highest revision in the session's commits, from its listing. */
  const listedRevision = (id: ConversationId) => call("list", commitsDir(id), () => io.list(commitsDir(id))).pipe(
    Effect.mapError(storeError("store.io", "list a session's commits")),
    Effect.map((names) => names.reduce((highest, name) => Option.match(revisionOfFile(name), { onNone: () => highest, onSome: (revision) => Math.max(highest, revision) }), 0)),
  )

  const commitBytes = (id: ConversationId, revision: number) =>
    call("read", commitPath(id, revision), () => io.read(commitPath(id, revision))).pipe(Effect.mapError(storeError("store.io", "read a commit")))

  /** A whole commit file, or `store.decode`: damage before the tail is not repaired. */
  const wholeCommit = (id: ConversationId, revision: number): Effect.Effect<CommitRecord, SessionLogError> =>
    commitBytes(id, revision).pipe(Effect.flatMap((bytes) => Result.match(decodeCommit(bytes), {
      onFailure: (damage) => Effect.fail(decodeError(`commit ${revision} of session ${id}`, `${damage}; it is not the session's last, so it is not repaired`)),
      onSuccess: Effect.succeed,
    })))

  /** Set a torn tail aside, its bytes kept, so the commit before it is the head again; another handle may have done it first. */
  const quarantine = (id: ConversationId, revision: number, damage: string) => Effect.gen(function* () {
    const folder = join(root, "quarantine", id)
    yield* call("mkdir", folder, () => io.mkdir(folder)).pipe(Effect.mapError(storeError("store.io", "create the quarantine")))
    const aside = join(folder, `${revisionFile(revision)}.${randomUUID()}`)
    yield* call("rename", commitPath(id, revision), () => io.rename(commitPath(id, revision), aside)).pipe(
      Effect.catchIf((error) => isCode(error, "ENOENT"), () => Effect.void),
      Effect.mapError(storeError("store.io", "set a torn commit aside")),
    )
    yield* Effect.logWarning(`a torn commit at the tail of the session (revision ${revision}, ${damage}) was moved to ${aside}; the commit before it is the session's head`).pipe(
      Effect.annotateLogs({ "efferent.session.id": id }),
    )
  })

  const tailOfRecord = (record: CommitRecord): Tail => ({ revision: record.meta.revision, seq: record.meta.last, at: record.meta.at, state: record.state })

  /** The tail at `revision`, read and checked: a torn one is set aside once, and the one before it must be whole. */
  const tailAt = (id: ConversationId, header: HeaderRecord, revision: number, repaired: boolean): Effect.Effect<{ readonly tail: Tail; readonly meta: Option.Option<CommitMeta> }, SessionLogError> => {
    if (revision === 0) return Effect.succeed({ tail: { revision: 0, seq: 0, at: header.createdNow, state: {} }, meta: Option.none() })
    return commitBytes(id, revision).pipe(Effect.flatMap((bytes) => {
      const decoded = decodeCommit(bytes)
      return Match.valueTags(tailVerdict(decoded, !repaired), {
        Intact: () => Result.match(decoded, {
          onFailure: () => Effect.fail(decodeError(`commit ${revision} of session ${id}`, "unreadable")),
          onSuccess: (record) => Effect.succeed({ tail: tailOfRecord(record), meta: Option.some(record.meta) }),
        }),
        Quarantine: ({ damage }) => quarantine(id, revision, damage).pipe(Effect.andThen(tailAt(id, header, revision - 1, true))),
        Corrupt: ({ damage }) => Effect.fail(decodeError(`commit ${revision} of session ${id}`, `${damage}, below a torn tail`)),
      })
    }))
  }

  /** The session's header and tail as they stand: from what this handle knew (if the session is the same one), then any later commit. */
  const current = (id: ConversationId): Effect.Effect<{ readonly header: HeaderRecord; readonly tail: Tail }, SessionMissing | SessionLogError> => Effect.gen(function* () {
    const header = yield* headerOf(id)
    const before = Option.filter(Option.fromNullishOr((yield* Ref.get(known)).get(id)), (entry) => entry.nonce === header.nonce)
    const start = yield* Option.match(before, {
      onNone: () => listedRevision(id),
      onSome: (entry) => entry.tail.revision === 0
        ? Effect.succeed(0)
        : exists(commitPath(id, entry.tail.revision)).pipe(Effect.flatMap((still) => still ? Effect.succeed(entry.tail.revision) : listedRevision(id))),
    })
    const revision = yield* probeForward(id, start)
    const same = Option.filter(before, (entry) => entry.tail.revision === revision)
    if (Option.isSome(same)) return { header, tail: same.value.tail }
    const found = yield* tailAt(id, header, revision, false)
    yield* remember(id, header.nonce, found.tail, Option.toArray(found.meta))
    return { header, tail: found.tail }
  })

  const remember = (id: ConversationId, headerNonce: PublishNonce, tail: Tail, metas: ReadonlyArray<CommitMeta>) => Ref.update(known, (all) => {
    const before = Option.filter(Option.fromNullishOr(all.get(id)), (entry) => entry.nonce === headerNonce)
    const kept = Option.match(before, { onNone: () => new Map<number, CommitMeta>(), onSome: (entry) => new Map(entry.metas) })
    metas.forEach((meta) => kept.set(meta.revision, meta))
    return new Map(all).set(id, { nonce: headerNonce, tail, metas: kept })
  })

  // A head's own copies: what a caller does with a returned header or state never reaches what this handle keeps.
  const headOf = (header: HeaderRecord, tail: Tail, now: number): SessionHead => ({
    header: { ...header.header, meta: structuredClone(header.header.meta) }, seq: tail.seq, revision: tail.revision, state: structuredClone(tail.state), updatedAt: tail.at, now,
  })

  /** A commit's first line, which says what it holds; from what this handle read before, else from the file's start. */
  const metaOf = (id: ConversationId, headerNonce: PublishNonce, revision: number): Effect.Effect<CommitMeta, SessionLogError> => Effect.gen(function* () {
    const cached = Option.flatMap(Option.filter(Option.fromNullishOr((yield* Ref.get(known)).get(id)), (entry) => entry.nonce === headerNonce), (entry) => Option.fromNullishOr(entry.metas.get(revision)))
    if (Option.isSome(cached)) return cached.value
    const start = yield* call("read", commitPath(id, revision), () => io.readStart(commitPath(id, revision), META_PREFIX)).pipe(Effect.mapError(storeError("store.io", "read a commit")))
    const text = decoder.decode(start)
    const line = text.slice(0, Math.max(0, text.indexOf("\n")))
    const meta = yield* Option.match(metaOfLine(line), {
      onSome: Effect.succeed,
      onNone: () => wholeCommit(id, revision).pipe(Effect.map((record) => record.meta)),
    })
    yield* Ref.update(known, (all) => Option.match(Option.fromNullishOr(all.get(id)), {
      onNone: () => all,
      onSome: (entry) => entry.nonce === headerNonce ? new Map(all).set(id, { ...entry, metas: new Map(entry.metas).set(revision, meta) }) : all,
    }))
    return meta
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
  const publish = (id: ConversationId, temporary: string, revision: number, ours: PublishNonce): Effect.Effect<Published, SessionLogError> =>
    call("link", commitPath(id, revision), () => io.link(temporary, commitPath(id, revision))).pipe(
      Effect.as<Published>({ _tag: "Published" }),
      Effect.catch((linkError) => call("read", commitPath(id, revision), () => io.read(commitPath(id, revision))).pipe(
        Effect.map((bytes): Published => Result.match(decodeCommit(bytes), {
          onSuccess: (record) => record.meta.nonce === ours ? { _tag: "Published" } : { _tag: "Taken" },
          onFailure: () => ({ _tag: "Taken" }),
        })),
        Effect.catchIf((error) => isCode(error, "ENOENT", "ENOTDIR"), () => exists(dirOf(id)).pipe(
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
  const sweepTemporaries = (id: ConversationId, revision: number) => Effect.gen(function* () {
    const first = yield* Ref.modify(swept, (done): [boolean, ReadonlySet<string>] => done.has(id) ? [false, done] : [true, new Set(done).add(id)])
    if (!first) return
    const folder = join(dirOf(id), "tmp")
    const names = yield* call("list", folder, () => io.list(folder)).pipe(
      Effect.tapError((error) => Effect.logDebug(`the temporary files of a session could not be listed (${error._tag}); they are swept at a later commit`)),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    )
    const dead = names.filter((name) => Option.exists(revisionOfTemporary(name), (written) => written <= revision))
    yield* Effect.forEach(dead, (name) => bestEffort("unlink", join(folder, name), () => io.unlink(join(folder, name))), { concurrency: 1, discard: true })
  })

  const createDirectory = (id: string) => join(root, "staging", `${id}.${randomUUID()}`)

  /** Rename a session's directory away and delete it; a missing one is nothing to do. */
  const discard = (id: string) => Effect.gen(function* () {
    const aside = join(root, "trash", `${id}.${randomUUID()}`)
    const moved = yield* call("rename", dirOf(id), () => io.rename(dirOf(id), aside)).pipe(
      Effect.as(true),
      Effect.catchIf((error) => isCode(error, "ENOENT"), () => Effect.succeed(false)),
      Effect.mapError(storeError("store.io", "remove a session")),
    )
    yield* Ref.update(known, (all) => { const rest = new Map(all); rest.delete(id); return rest })
    if (moved) yield* bestEffort("remove", aside, () => io.removeTree(aside))
  })

  /** The ids of the sessions whose header names `parent` as theirs. */
  const childrenOf = (parent: string): Effect.Effect<ReadonlyArray<ConversationId>, SessionLogError> => Effect.gen(function* () {
    const names = yield* call("list", sessionsDir, () => io.list(sessionsDir)).pipe(Effect.mapError(storeError("store.io", "list the sessions")))
    const headers = yield* Effect.forEach(names.flatMap((name) => Option.toArray(sessionIdOf(name))), (name) => headerOf(name).pipe(
      Effect.map(Option.some),
      Effect.catchTag("SessionMissing", () => Effect.succeedNone),
    ), { concurrency: 2 })
    return headers.flatMap((found) => Option.match(found, {
      onNone: () => [],
      onSome: (record) => Option.exists(record.header.parent, (lineage) => lineage.id === parent) ? [record.header.id] : [],
    }))
  })

  const removeTree = (id: ConversationId): Effect.Effect<void, SessionLogError> => Effect.gen(function* () {
    const children = yield* childrenOf(id)
    yield* discard(id)
    yield* Effect.forEach(children, removeTree, { concurrency: 1, discard: true })
  })

  return SessionLog.of({
    create: Effect.fn("session_log.create")(function* (header: SessionHeader) {
      const meta = yield* storedJson(header.meta).pipe(Effect.mapError((error) => new SessionLogError({ code: "store.encode", message: `the meta is not JSON: ${error.message}`, cause: error })))
      const parent = header.parent
      if (Option.isSome(parent) && !(yield* exists(headerPath(parent.value.id)))) return yield* Effect.fail(new SessionMissing({ session: parent.value.id }))
      const now = yield* Clock.currentTimeMillis
      const record: HeaderRecord = { header: { ...header, meta }, createdNow: now, nonce: nonce() }
      const text = yield* Result.match(headerText(record), {
        onFailure: (error) => Effect.fail(new SessionLogError({ code: "store.encode", message: `the header does not encode: ${error.message}`, cause: error })),
        onSuccess: Effect.succeed,
      })
      const staged = createDirectory(header.id)
      yield* Effect.forEach([join(staged, "commits"), join(staged, "tmp")], (path) => call("mkdir", path, () => io.mkdir(path)), { concurrency: 1, discard: true }).pipe(
        Effect.andThen(call("create", join(staged, "header.json"), () => io.create(join(staged, "header.json"), encoder.encode(text)))),
        Effect.mapError(storeError("store.io", "stage a new session")),
      )
      // A rename never lands over a session's directory, which is never empty: one that exists refuses it.
      const outcome = yield* call("rename", dirOf(header.id), () => io.rename(staged, dirOf(header.id))).pipe(
        Effect.as<"created" | "exists">("created"),
        Effect.catch((renameError) => headerOf(header.id).pipe(
          Effect.map((found): "created" | "exists" => found.nonce === record.nonce ? "created" : "exists"),
          Effect.catchTag("SessionMissing", () => Effect.fail(storeError("store.io", "publish a new session")(renameError))),
        )),
      )
      if (outcome === "exists") {
        yield* bestEffort("remove", staged, () => io.removeTree(staged))
        return yield* Effect.fail(new SessionExists({ session: header.id }))
      }
      // The parent may have been removed while this child was staged: the child goes with it.
      if (Option.isSome(parent) && !(yield* exists(headerPath(parent.value.id)))) {
        yield* discard(header.id)
        return yield* Effect.fail(new SessionMissing({ session: parent.value.id }))
      }
      const tail: Tail = { revision: 0, seq: 0, at: now, state: {} }
      yield* remember(header.id, record.nonce, tail, [])
      return headOf(record, tail, now)
    }, (effect, header) => onSession(effect, header.id)),

    head: Effect.fn("session_log.head")(function* (id: ConversationId) {
      const { header, tail } = yield* current(id)
      return headOf(header, tail, yield* Clock.currentTimeMillis)
    }, onSession),

    list: Effect.fn("session_log.list")(function* (query: SessionListQuery) {
      const now = yield* Clock.currentTimeMillis
      const names = yield* call("list", sessionsDir, () => io.list(sessionsDir)).pipe(Effect.mapError(storeError("store.io", "list the sessions")))
      const heads = yield* Effect.forEach(names.flatMap((name) => Option.toArray(sessionIdOf(name))), (name) => headerOf(name).pipe(
        Effect.flatMap((record) => inListing(record, query)
          ? current(record.header.id).pipe(Effect.map(({ header, tail }) => Option.some(headOf(header, tail, now))))
          : Effect.succeedNone),
        // A session removed while it was listed is not in the listing.
        Effect.catchTag("SessionMissing", () => Effect.succeedNone),
      ), { concurrency: 2 })
      return page(heads.flatMap(Option.toArray), query)
    }),

    read: Effect.fn("session_log.read")(function* (id: ConversationId, query: SessionReadQuery) {
      const { header, tail } = yield* current(id)
      const limit = Option.match(query.limit, { onNone: () => Number.POSITIVE_INFINITY, onSome: (value) => Math.max(0, value) })
      const wanted = (kind: string) => query.kinds.length === 0 || query.kinds.includes(kind)
      const revisions = Array.from({ length: tail.revision }, (_, index) => index + 1)
      return yield* Effect.reduce(revisions, (): ReadonlyArray<SessionLogEvent> => [], (events, revision) => {
        if (events.length >= limit) return Effect.succeed(events)
        return metaOf(id, header.nonce, revision).pipe(Effect.flatMap((meta) =>
          meta.last <= query.after || meta.first > meta.last || !meta.kinds.some(wanted)
            ? Effect.succeed(events)
            : wholeCommit(id, revision).pipe(Effect.map((record) => [
              ...events,
              ...record.events.filter((event) => event.seq > query.after && wanted(event.kind)).map(eventOf(id, record.meta.at)),
            ].slice(0, limit)))))
      })
    }, onSession),

    commit: Effect.fn("session_log.commit")(function* (id: ConversationId, commit: SessionCommit) {
      const data = yield* Effect.forEach(commit.events, (draft) => storedJson(draft.data).pipe(
        Effect.mapError((error) => new SessionLogError({ code: "store.encode", message: `the data is not JSON: ${error.message}`, cause: error })),
      ), { concurrency: 1 })
      const { header, tail } = yield* current(id)
      if (tail.revision !== commit.expect) return yield* Effect.fail(new RevisionConflict({ session: id, expected: commit.expect, actual: tail.revision }))
      const at = yield* Clock.currentTimeMillis
      if (Option.isSome(commit.notAfter) && at > commit.notAfter.value) return yield* Effect.fail(new LeaseExpired({ session: id, notAfter: commit.notAfter.value, now: at }))
      const revision = tail.revision + 1
      const events: ReadonlyArray<CommitEvent> = commit.events.map((draft, index) => ({
        seq: tail.seq + index + 1, turn: Option.getOrNull(draft.turn), kind: draft.kind, data: data[index] ?? {},
      }))
      const ours = nonce()
      const meta: CommitMeta = {
        layout: FILES_LAYOUT, session: id, revision, first: tail.seq + 1, last: tail.seq + events.length, at,
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
        const outcome = yield* publish(id, temporary, revision, ours)
        yield* bestEffort("unlink", temporary, () => io.unlink(temporary))
        if (outcome._tag === "Published") yield* bestEffort("sync", commitsDir(id), () => io.syncDirectory(commitsDir(id)))
        return outcome
      }))
      return yield* Match.valueTags(published, {
        Published: (): Effect.Effect<SessionCommitted, RevisionConflict | SessionMissing | SessionLogError> => remember(id, header.nonce, { revision, seq: meta.last, at, state }, [meta]).pipe(
          Effect.andThen(sweepTemporaries(id, revision)),
          Effect.as({ revision, seq: meta.last, events: events.map(eventOf(id, at)), at }),
        ),
        Taken: () => current(id).pipe(Effect.flatMap((after) => Effect.fail(new RevisionConflict({ session: id, expected: commit.expect, actual: after.tail.revision })))),
        Missing: () => Effect.fail(new SessionMissing({ session: id })),
      })
    }, onSession),

    remove: Effect.fn("session_log.remove")(function* (id: ConversationId) {
      yield* removeTree(id)
    }, onSession),
  })
})

/** The session log in a directory (see `makeSessionLogFiles`). @public */
export const SessionLogFilesLive = (root: string, options?: SessionLogFilesOptions): Layer.Layer<SessionLog, SessionLogError> =>
  Layer.effect(SessionLog, makeSessionLogFiles(root, options))
