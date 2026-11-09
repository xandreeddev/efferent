import { Database } from "bun:sqlite"
import { mkdir } from "node:fs/promises"
import { chmodSync } from "node:fs"
import { dirname } from "node:path"
import { Array as Arr, Cause, Clock, Duration, Effect, Layer, Match, Option, Schedule, Schema } from "effect"
import type { Scope } from "effect"
import {
  ConversationId,
  definePlugin,
  errorCodeOf,
  isStoreBusy,
  JsonObject,
  LeaseExpired,
  RevisionConflict,
  SessionExists,
  SessionIncarnation,
  SessionLog,
  SessionLogError,
  SessionMissing,
  reasonOf,
  storedJson,
} from "@xandreed/core"
import type { SessionCommit, SessionCommitted, SessionHead, SessionHeader, SessionListQuery, SessionLogEvent, SessionReadQuery, SessionRef } from "@xandreed/core"

/** A column holding a JSON object as text. */
const JsonColumn = Schema.fromJsonString(JsonObject)

/** A `session_heads` row, decoded: a row that is not one (a damaged or hand-edited file) fails with `store.decode`. */
const HeadRow = Schema.Struct({
  id: ConversationId,
  owner: Schema.String,
  origin: Schema.String,
  created_at: Schema.Number,
  meta: JsonColumn,
  parent_id: Schema.NullOr(ConversationId),
  parent_owner: Schema.NullOr(Schema.String),
  parent_incarnation: Schema.NullOr(SessionIncarnation),
  parent_through: Schema.NullOr(Schema.Int),
  turn_at_fork: Schema.NullOr(Schema.Int),
  seq: Schema.Int,
  revision: Schema.Int,
  state: JsonColumn,
  updated_at: Schema.Number,
  /** Empty for a row a release without schema 2 wrote into a file this release migrated (it fences nothing). */
  incarnation: SessionIncarnation,
})

/** A `session_log_events` row, decoded like `HeadRow`. */
const EventRow = Schema.Struct({ seq: Schema.Int, turn: Schema.NullOr(Schema.Int), kind: Schema.String, at: Schema.Number, data: JsonColumn })

/** SQLite's busy result and its extended forms (`SQLITE_BUSY_SNAPSHOT`, …): another connection holds the lock. */
const busy = (error: unknown): boolean => Option.exists(errorCodeOf(error), (code) => code.startsWith("SQLITE_BUSY"))
/**
 * A store failure as a SessionLogError: `store.busy` when another connection
 * held the lock, else `code`; SQLite's (or the file system's) error is its
 * `cause`, and its message says what that error said.
 */
const failure = (code: string) => (error: unknown) =>
  new SessionLogError({ code: busy(error) ? "store.busy" : code, message: `the SQLite store failed: ${reasonOf(Cause.die(error))}`, cause: error })
/** A row decoded with `schema`, or `store.decode` naming the table. */
const decodeRow = <S extends Schema.Decoder<unknown>>(schema: S, table: string) => {
  const decode = Schema.decodeUnknownEffect(schema)
  return (row: unknown): Effect.Effect<S["Type"], SessionLogError, S["DecodingServices"]> =>
    decode(row).pipe(Effect.mapError((error) => new SessionLogError({ code: "store.decode", message: `a ${table} row does not decode: ${error.message}`, cause: error })))
}
const decodeHead = decodeRow(HeadRow, "session_heads")
const decodeEvent = decodeRow(EventRow, "session_log_events")
/** The value as it is stored and read back (JSON), so a commit returns the events a later read does; a value JSON cannot hold fails with `store.encode`. */
const asStored = (data: JsonObject): Effect.Effect<JsonObject, SessionLogError> =>
  storedJson(data).pipe(Effect.mapError((error) => new SessionLogError({ code: "store.encode", message: `the data is not JSON: ${error.message}`, cause: error })))

/**
 * How long a call waits in all for a lock another connection holds before
 * it fails with `store.busy`. SQLite's own busy wait would sleep on the
 * JavaScript thread (bun:sqlite is synchronous) and stop every fiber, so
 * the connection's `busy_timeout` is 0 and the waiting happens here,
 * between tries: 2 ms doubling to 100 ms, jittered.
 */
const BUSY_WAIT = Duration.seconds(5)
const busyRetry = Schedule.exponential("2 millis").pipe(
  Schedule.modifyDelay(({ duration }) => Effect.succeed(Math.min(Duration.toMillis(duration), 100))),
  Schedule.jittered,
  Schedule.upTo({ duration: BUSY_WAIT }),
)

/** `effect` again, by `busyRetry`, while it fails with `store.busy`. */
const whileBusy = <A, R>(effect: Effect.Effect<A, SessionLogError, R>): Effect.Effect<A, SessionLogError, R> =>
  effect.pipe(Effect.retry({ schedule: busyRetry, while: isStoreBusy }))

/** One synchronous store call, tried again while another connection holds the lock it needs. */
const operation = <A>(work: () => A) => whileBusy(Effect.try({ try: work, catch: failure("store.io") }))

/** A pipeable of `Effect.fn`: the session's id on the span the call opens, as `efferent.session.id`. */
const onSession = <A, E, R>(effect: Effect.Effect<A, E, R>, id: ConversationId): Effect.Effect<A, E, R> =>
  Effect.annotateCurrentSpan("efferent.session.id", id).pipe(Effect.andThen(effect))

const SCHEMA_VERSION = 3
const CURRENT_SCHEMA = `
  CREATE TABLE session_heads (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, origin TEXT NOT NULL, created_at INTEGER NOT NULL, meta TEXT NOT NULL,
    incarnation TEXT NOT NULL,
    parent_id TEXT, parent_owner TEXT, parent_incarnation TEXT, parent_through INTEGER, turn_at_fork INTEGER,
    seq INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(id, owner, incarnation),
    FOREIGN KEY(parent_id, parent_owner, parent_incarnation) REFERENCES session_heads(id, owner, incarnation) ON DELETE CASCADE,
    CHECK ((parent_id IS NULL AND parent_owner IS NULL AND parent_incarnation IS NULL) OR (parent_id IS NOT NULL AND parent_owner = owner AND parent_incarnation IS NOT NULL)));
  CREATE INDEX session_heads_owner ON session_heads(owner, updated_at DESC, id DESC);
  CREATE INDEX session_heads_parent ON session_heads(parent_id, parent_owner, parent_incarnation);
  CREATE TABLE session_log_events (
    session_id TEXT NOT NULL REFERENCES session_heads(id) ON DELETE CASCADE, seq INTEGER NOT NULL, turn INTEGER,
    kind TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id, seq));
  CREATE INDEX session_log_events_kind ON session_log_events(session_id, kind, seq);
`

/** Initialize a fresh database; unsupported schemas are refused without DDL. */
export const initializeSessionDatabase = (db: Database): Effect.Effect<void, SessionLogError> =>
  operation(() => db.transaction(() => {
    const found = db.query<{ readonly user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0
    if (found === SCHEMA_VERSION) return Option.none<number>()
    const tables = db.query<{ readonly name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
    if (found !== 0 || tables.length !== 0) return Option.some(found)
    db.exec(CURRENT_SCHEMA)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    return Option.none<number>()
  }).immediate()).pipe(Effect.flatMap(Option.match({
    onNone: () => Effect.void,
    onSome: (found) => Effect.fail(new SessionLogError({ code: "store.version", message: `the session database is at unsupported schema ${found}; configure a fresh store for schema ${SCHEMA_VERSION}` })),
  })))

/**
 * The session log's SQLite file, opened (and created, readable by its owner
 * only) for the scope: WAL with `synchronous = NORMAL`, foreign keys on, no
 * busy wait on the thread (`busy_timeout = 0`, see `BUSY_WAIT`), and the
 * tables at this release's schema (`migrateSessionDatabase`). One
 * `session_log.open` span.
 */
export const openSessionDatabase = Effect.fn("session_log.open")(function* (path: string): Effect.fn.Return<Database, SessionLogError, Scope.Scope> {
  yield* Effect.tryPromise({ try: () => mkdir(dirname(path), { recursive: true }), catch: failure("store.open") })
  const db = yield* Effect.acquireRelease(
    Effect.try({ try: () => new Database(path, { create: true, strict: true }), catch: failure("store.open") }),
    (database) => Effect.sync(() => database.close()),
  )
  yield* operation(() => chmodSync(path, 0o600))
  yield* operation(() => db.exec("PRAGMA busy_timeout = 0; PRAGMA foreign_keys = ON;"))
  // Switching a new file to WAL takes a lock that another process opening it at once may hold: tried until it is WAL.
  yield* initializeSessionDatabase(db)
  yield* whileBusy(Effect.try({
    try: () => db.query<{ readonly journal_mode: string }, []>("PRAGMA journal_mode = WAL").get()?.journal_mode,
    catch: failure("store.io"),
  }).pipe(Effect.filterOrFail((mode) => mode === "wal", (mode) => new SessionLogError({ code: "store.busy", message: `the journal stayed ${mode ?? "unknown"}, not WAL` }))))
  yield* operation(() => db.exec("PRAGMA synchronous = NORMAL;"))
  // Under the write lock, so a process never creates its tables over a schema another is still writing.
  return db
})

const headOf = (row: typeof HeadRow.Type, now: number): SessionHead => ({
  header: {
    id: row.id,
    owner: row.owner,
    origin: row.origin,
    createdAt: row.created_at,
    meta: row.meta,
    parent: row.parent_id === null ? Option.none() : Option.some({
      id: row.parent_id, owner: row.parent_owner!, incarnation: row.parent_incarnation!, through: row.parent_through ?? 0, turnAtFork: row.turn_at_fork ?? 0,
    }),
  },
  incarnation: row.incarnation,
  seq: row.seq,
  revision: row.revision,
  state: row.state,
  updatedAt: row.updated_at,
  now,
})

const eventOf = (session: ConversationId) => (row: typeof EventRow.Type): SessionLogEvent => ({
  session, seq: row.seq, turn: Option.fromNullishOr(row.turn), kind: row.kind, at: row.at, data: row.data,
})

/** A commit's outcome inside its transaction, with the time it was decided at. */
type Outcome =
  | { readonly _tag: "Done"; readonly committed: SessionCommitted }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Conflict"; readonly actual: number }
  | { readonly _tag: "Expired"; readonly at: number }

/**
 * The authoritative session journal in one SQLite file: `session_heads`
 * and `session_log_events`. Removal cascades to events and children. A commit is one
 * IMMEDIATE transaction that checks the revision, the clock and the
 * session's incarnation (a column each session gets when it is created)
 * before it writes. The clock is the caller's Effect `Clock`, read once the transaction
 * holds the write lock: a commit that waited for another connection past its
 * `notAfter` is refused, and events carry the time they were committed. A
 * call waits for another connection's lock without blocking the thread, for
 * up to 5 s (`BUSY_WAIT`), then fails with `store.busy`. The journal is WAL
 * with `synchronous = NORMAL`: a commit is atomic and survives a crash of
 * the process; a power loss may drop the last commits, never tear one. A
 * row that does not decode fails with `store.decode`, whichever call read it.
 * Each call is a `session_log.<op>` span, with `efferent.session.id` when
 * it names a session.
 */
export const makeSessionLogSqlite = Effect.fnUntraced(function* (path: string): Effect.fn.Return<SessionLog["Service"], SessionLogError, Scope.Scope> {
  const db = yield* openSessionDatabase(path)
  const headRow = (id: string) => db.query<Record<string, unknown>, [string]>("SELECT * FROM session_heads WHERE id = ?").get(id)

  const log = SessionLog.of({
    create: Effect.fn("session_log.create")(function* ({ header, state }: { readonly header: SessionHeader; readonly state: JsonObject }) {
      const incarnation = SessionIncarnation.make(crypto.randomUUID())
      const meta = yield* asStored(header.meta)
      const initial = yield* asStored(state)
      const { outcome, now } = yield* Clock.clockWith((clock) => operation(() => db.transaction(() => {
        const now = clock.currentTimeMillisUnsafe()
        if (headRow(header.id) !== null) return { outcome: "exists" as const, now }
        const parent = Option.getOrNull(header.parent)
        if (parent !== null && db.query("SELECT id FROM session_heads WHERE id = ? AND owner = ? AND incarnation = ?").get(parent.id, parent.owner, parent.incarnation) === null) return { outcome: "orphan" as const, now }
        if (parent !== null && parent.owner !== header.owner) return { outcome: "orphan" as const, now }
        db.query("INSERT INTO session_heads (id, owner, origin, created_at, meta, parent_id, parent_owner, parent_incarnation, parent_through, turn_at_fork, updated_at, incarnation, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(header.id, header.owner, header.origin, header.createdAt, JSON.stringify(meta), parent?.id ?? null, parent?.owner ?? null, parent?.incarnation ?? null, parent?.through ?? null, parent?.turnAtFork ?? null, now, incarnation, JSON.stringify(initial))
        return { outcome: "created" as const, now }
      }).immediate()))
      if (outcome === "exists") return yield* Effect.fail(new SessionExists({ session: header.id }))
      if (outcome === "orphan") return yield* Effect.fail(new SessionMissing({ session: Option.match(header.parent, { onNone: () => header.id, onSome: (parent) => parent.id }) }))
      return { header: { ...header, meta }, incarnation, seq: 0, revision: 0, state: initial, updatedAt: now, now }
    }, (effect, input) => onSession(effect, input.header.id)),
    head: Effect.fn("session_log.head")(function* (id: ConversationId) {
      const now = yield* Clock.currentTimeMillis
      const row = yield* operation(() => headRow(id))
      if (row === null) return yield* Effect.fail(new SessionMissing({ session: id }))
      return headOf(yield* decodeHead(row), now)
    }, onSession),
    list: Effect.fn("session_log.list")(function* (query: SessionListQuery) {
      const now = yield* Clock.currentTimeMillis
      const rows = yield* operation(() => {
        const before = Option.getOrNull(query.before)
        const parent = Option.getOrNull(query.parent)
        return db.query<Record<string, unknown>, [string, string | null, string | null, string | null, string | null, number | null, number | null, number | null, string | null, number]>(`
          SELECT * FROM session_heads
          WHERE owner = ? AND ((? IS NULL AND parent_id IS NULL) OR (parent_id = ? AND parent_owner = ? AND parent_incarnation = ?))
            AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND id < ?))
          ORDER BY updated_at DESC, id DESC LIMIT ?`)
          .all(query.owner, parent?.id ?? null, parent?.id ?? null, parent?.owner ?? null, parent?.incarnation ?? null, before?.updatedAt ?? null, before?.updatedAt ?? null, before?.updatedAt ?? null, before?.id ?? null, Math.max(0, query.limit))
      })
      return yield* Effect.forEach(rows, (row) => decodeHead(row).pipe(Effect.map((head) => headOf(head, now))), { concurrency: 1 })
    }),
    read: Effect.fn("session_log.read")(function* (reference: SessionRef, query: SessionReadQuery) {
      const id = reference.id
      const kinds = query.kinds.length === 0 ? "" : ` AND kind IN (${query.kinds.map(() => "?").join(", ")})`
      const through = query.through === undefined ? "" : " AND seq <= ?"
      const ceiling = query.through === undefined ? [] : [query.through]
      const limit = Option.match(query.limit, { onNone: () => -1, onSome: (value) => Math.max(0, value) })
      const selected = `SELECT seq, turn, kind, at, data FROM session_log_events WHERE session_id = ? AND seq > ?${through}${kinds}`
      // From the end, the primary key (and the kind index) is walked backwards for the newest `limit` rows, put back in order.
      const statement = query.from === "end" ? `SELECT * FROM (${selected} ORDER BY seq DESC LIMIT ?) ORDER BY seq` : `${selected} ORDER BY seq LIMIT ?`
      const rows = yield* operation(() => db.transaction(() => {
        if (db.query("SELECT id FROM session_heads WHERE id = ? AND owner = ? AND incarnation = ?").get(id, reference.owner, reference.incarnation) === null) return null
        return db.query<Record<string, unknown>, Array<string | number>>(statement).all(id, query.after, ...ceiling, ...query.kinds, limit)
      })())
      if (rows === null) return yield* Effect.fail(new SessionMissing({ session: id }))
      return yield* Effect.forEach(rows, (row) => decodeEvent(row).pipe(Effect.map(eventOf(id))), { concurrency: 1 })
    }, (effect, reference) => onSession(effect, reference.id)),
    commit: Effect.fn("session_log.commit")(function* (reference: SessionRef, commit: SessionCommit) {
      const id = reference.id
      const data = yield* Effect.forEach(commit.events, (draft) => asStored(draft.data), { concurrency: 1 })
      const outcome = yield* Clock.clockWith((clock) => operation(() => db.transaction((): Outcome => {
        // The time is read under the write lock: a commit that waited for it is judged, and stamped, when it writes.
        const at = clock.currentTimeMillisUnsafe()
        const head = db.query<{ readonly seq: number; readonly revision: number; readonly incarnation: string; readonly owner: string }, [string]>("SELECT seq, revision, incarnation, owner FROM session_heads WHERE id = ?").get(id)
        // A session removed and created again under its id is another incarnation: missing to a writer of the one before.
        if (head === null || reference.incarnation !== head.incarnation || reference.owner !== head.owner) return { _tag: "Missing" }
        if (head.revision !== commit.expect) return { _tag: "Conflict", actual: head.revision }
        if (Option.isSome(commit.notAfter) && at > commit.notAfter.value) return { _tag: "Expired", at }
        const events = Arr.zip(commit.events, data).map(([draft, stored], index): SessionLogEvent => ({
          session: id, seq: head.seq + index + 1, turn: draft.turn, kind: draft.kind, at, data: stored,
        }))
        const insert = db.query("INSERT INTO session_log_events (session_id, seq, turn, kind, at, data) VALUES (?, ?, ?, ?, ?, ?)")
        events.forEach((event) => insert.run(id, event.seq, Option.getOrNull(event.turn), event.kind, at, JSON.stringify(event.data)))
        db.query("UPDATE session_heads SET revision = revision + 1, seq = ?, state = COALESCE(?, state), updated_at = ? WHERE id = ?")
          .run(head.seq + events.length, Option.match(commit.state, { onNone: () => null, onSome: (state) => JSON.stringify(state) }), at, id)
        return { _tag: "Done", committed: { revision: head.revision + 1, seq: head.seq + events.length, events, at } }
      }).immediate()))
      return yield* Match.valueTags(outcome, {
        Done: (outcome): Effect.Effect<SessionCommitted, RevisionConflict | LeaseExpired | SessionMissing> => Effect.succeed(outcome.committed),
        Missing: () => Effect.fail(new SessionMissing({ session: id })),
        Conflict: (outcome) => Effect.fail(new RevisionConflict({ session: id, expected: commit.expect, actual: outcome.actual })),
        Expired: (outcome) => Effect.fail(new LeaseExpired({ session: id, notAfter: Option.getOrElse(commit.notAfter, () => outcome.at), now: outcome.at })),
      })
    }, (effect, reference) => onSession(effect, reference.id)),
    remove: Effect.fn("session_log.remove")(function* (reference: SessionRef) {
      const result = yield* operation(() => db.query("DELETE FROM session_heads WHERE id = ? AND owner = ? AND incarnation = ?").run(reference.id, reference.owner, reference.incarnation))
      if (result.changes === 0) return yield* Effect.fail(new SessionMissing({ session: reference.id }))
    }, (effect, reference) => onSession(effect, reference.id)),
  })
  return log
})

/** The session log over one SQLite file (see `makeSessionLogSqlite`). */
export const SessionLogSqliteLive = (path: string): Layer.Layer<SessionLog, SessionLogError> =>
  Layer.effect(SessionLog, makeSessionLogSqlite(path))

const LogConfig = Schema.Struct({ path: Schema.String })

/** The session log in a SQLite file, as a plugin: provides SessionLog. */
export const sessionLogSqlitePlugin = definePlugin({
  id: "@xandreed/plugin-session-sqlite/log", version: "0.19.2", scope: "runtime",
  config: LogConfig, defaults: { path: ".efferent/runtime/sessions.db" }, provides: [SessionLog],
  layer: ({ path }) => SessionLogSqliteLive(path),
})
