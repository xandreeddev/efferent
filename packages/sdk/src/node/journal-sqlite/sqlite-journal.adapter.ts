import { mkdir, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { Array as Arr, Clock, Effect, Layer, Option, Predicate, Result, Schema, Semaphore } from "effect"
import { byCreation, JournalStorage, JournalStorageError, Seq, SessionHeader, StoredEvent } from "@xandreed/core"
import type { Journal, SessionId } from "@xandreed/core"
import { holdWriter } from "../writer/writer.adapter.js"
import { JournalOpenFailed } from "../writer/writer.entity.js"
import { errorCodeOf, messageOf } from "../writer/writer.entity.functions.js"
import { DatabaseHeader, EventRow, LastRow, SessionRow, SQLITE_APPLICATION_ID, SQLITE_SCHEMA } from "./sqlite-journal.entity.js"
import type { SqliteJournalOptions } from "./sqlite-journal.entity.js"

/** A value a statement is given. */
type Bound = string | number

/**
 * A database connection as the journal uses it, whichever runtime's driver opened it: Bun's `bun:sqlite` or Node's
 * `node:sqlite`. Every call is synchronous: it throws what the driver throws.
 */
interface Connection {
  readonly exec: (sql: string) => void
  readonly all: (sql: string, params: ReadonlyArray<Bound>) => ReadonlyArray<unknown>
  readonly run: (sql: string, params: ReadonlyArray<Bound>) => void
  readonly close: () => void
}

/** Whether this process runs on Bun: its SQLite driver is `bun:sqlite`; Node's is `node:sqlite`. */
const onBun = typeof process.versions.bun === "string"

/**
 * A connection to the file at `path`, made by this runtime's driver, loaded only now: neither module is imported
 * where the other runs. A read-only one changes nothing of the file, its WAL included.
 */
const connect = (path: string, readOnly: boolean): Promise<Connection> => onBun
  ? import("bun:sqlite").then(({ Database }) => {
    const db = readOnly ? new Database(path, { readonly: true, strict: true }) : new Database(path, { create: true, strict: true })
    return {
      exec: (sql) => { db.exec(sql) },
      all: (sql, params) => db.query(sql).all(...params),
      run: (sql, params) => { db.query(sql).run(...params) },
      close: () => db.close(),
    }
  })
  : import("node:sqlite").then(({ DatabaseSync }) => {
    const db = new DatabaseSync(path, { readOnly })
    return {
      exec: (sql) => { db.exec(sql) },
      all: (sql, params) => db.prepare(sql).all(...params),
      run: (sql, params) => { db.prepare(sql).run(...params) },
      close: () => db.close(),
    }
  })

/** SQLite's answer that a file is no database, as Bun's driver (`SQLITE_NOTADB`) or Node's (`errcode` 26) says it. */
const isNotADatabase = (error: unknown): boolean =>
  Option.contains(errorCodeOf(error), "SQLITE_NOTADB") || (Predicate.isObject(error) && error["errcode"] === 26)

const SCHEMA = `
  CREATE TABLE sessions (id TEXT NOT NULL PRIMARY KEY, header TEXT NOT NULL) WITHOUT ROWID;
  CREATE TABLE events (session TEXT NOT NULL, seq INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY (session, seq)) WITHOUT ROWID;
  PRAGMA application_id = ${SQLITE_APPLICATION_ID};
  PRAGMA user_version = ${SQLITE_SCHEMA};
`

const headerJson = Schema.fromJsonString(SessionHeader)
const eventJson = Schema.fromJsonString(StoredEvent)
const decodeHeader = Schema.decodeUnknownResult(headerJson)
const decodeEvent = Schema.decodeUnknownResult(eventJson)
const encodeHeader = Schema.encodeUnknownEffect(headerJson)
const encodeEvent = Schema.encodeUnknownEffect(eventJson)
const decodeDatabase = Schema.decodeUnknownResult(DatabaseHeader)
const decodeSessionRow = Schema.decodeUnknownResult(SessionRow)
const decodeEventRow = Schema.decodeUnknownResult(EventRow)
const decodeLast = Schema.decodeUnknownResult(LastRow)

const missing = (id: SessionId) => new JournalStorageError({ reason: "SessionMissing", message: `no session ${id}` })
const exists = (id: SessionId) => new JournalStorageError({ reason: "SessionExists", message: `session ${id} exists` })
const unreadable = (what: string) => new JournalStorageError({ reason: "Unreadable", message: `${what} is not a journal's` })

/** Rows a query gives, each decoded; a row that does not decode is `Unreadable`. */
const decodedRows = <A>(rows: ReadonlyArray<unknown>, decode: (row: unknown) => Result.Result<A, unknown>, what: string): Result.Result<ReadonlyArray<A>, JournalStorageError> =>
  Result.all(rows.map((row) => Result.mapError(decode(row), () => unreadable(what))))

/**
 * Journals in one SQLite file, on Bun (`bun:sqlite`) and on Node 24
 * (`node:sqlite`): one adapter, the driver chosen when the layer is built
 * (ADR 0024).
 *
 * - The database is in WAL mode with `synchronous = FULL`: an append, one
 *   `BEGIN IMMEDIATE` transaction that checks the place and inserts the
 *   event, is on the disk when it returns, and a crash in the middle of one
 *   leaves the database as it was before it. A session and a branch are each
 *   one transaction too.
 * - One writer per database, a process: the layer takes the store as it is
 *   built (the folder `<path>.writer`, ADR 0024) and fails with
 *   `JournalOpenFailed` (`Held`) while another live process holds it; it is
 *   taken over from a holder whose process is gone. SQLite's own locks order
 *   one transaction at a time; they do not name the store's one writer
 *   between transactions, which the lock folder does.
 *   Two layers of one process share the hold, each with its own connection,
 *   and their writes take one lane.
 * - The schema (`PRAGMA user_version`, `SQLITE_SCHEMA`) and the application
 *   (`PRAGMA application_id`, `SQLITE_APPLICATION_ID`) are checked as it
 *   opens: a database of another schema or application, a file that is no
 *   database, or one with tables and no version, is refused (`Format`). An
 *   empty file, or none, becomes a journal database.
 *
 * A row that does not decode is `Unreadable`; a driver that fails is
 * `Unavailable`. Each call is one span, `journal_sqlite.<call>`.
 *
 * @public
 */
export const sqliteJournal = (options: SqliteJournalOptions): Layer.Layer<JournalStorage, JournalOpenFailed> => Layer.effect(JournalStorage, Effect.gen(function* () {
  const path = options.path
  const refused = (reason: JournalOpenFailed["reason"], what: string) => (cause: unknown) =>
    new JournalOpenFailed({ reason, store: path, message: `${what}: ${messageOf(cause)}`, cause })
  yield* Effect.tryPromise({ try: () => mkdir(dirname(path), { recursive: true, mode: 0o700 }), catch: refused("Unavailable", `the folder of ${path} could not be made`) })
  /** A connection for the scope, closed with it. */
  const opened = (readOnly: boolean) => Effect.acquireRelease(
    Effect.tryPromise({ try: () => connect(path, readOnly), catch: refused("Unavailable", `${path} could not be opened`) }),
    (connection) => Effect.try({ try: () => connection.close(), catch: (cause) => cause }).pipe(
      Effect.catch((cause) => Effect.logWarning(`the journal database ${path} did not close cleanly`, cause)),
    ),
  )
  /**
   * What the file says it holds, refused unless it is a journal database of this schema or a fresh one: a file that is
   * no database, another application's, or another schema's.
   */
  const checked = (connection: Connection) => Effect.gen(function* () {
    const read = yield* Effect.try({
      try: () => decodeDatabase(connection.all(
        "SELECT (SELECT user_version FROM pragma_user_version) AS version, (SELECT application_id FROM pragma_application_id) AS application, (SELECT count(*) FROM sqlite_master WHERE type = 'table') AS tables",
        [],
      )[0]),
      catch: (cause) => isNotADatabase(cause) ? refused("Format", `${path} is not a SQLite database`)(cause) : refused("Unavailable", `${path} could not be read`)(cause),
    })
    const found = yield* Effect.mapError(Effect.fromResult(read), refused("Format", `${path} does not say what it holds`))
    const fresh = found.version === 0 && found.tables === 0
    if (!fresh && found.application !== SQLITE_APPLICATION_ID) {
      return yield* Effect.fail(new JournalOpenFailed({ reason: "Format", store: path, message: `${path} is another application's database (application id ${found.application}), not a journal database` }))
    }
    if (!fresh && found.version !== SQLITE_SCHEMA) {
      return yield* Effect.fail(new JournalOpenFailed({ reason: "Format", store: path, message: `${path} is at schema ${found.version}; this release reads schema ${SQLITE_SCHEMA} only, and does not migrate` }))
    }
    return fresh
  })
  // A file that is there is read first on a connection that changes nothing of it, before the store is taken: one this
  // store does not read is refused as it was found, its WAL included.
  const there = yield* Effect.tryPromise({ try: () => stat(path).then(() => true, (error: unknown) => Option.contains(errorCodeOf(error), "ENOENT") ? false : Promise.reject(error)), catch: refused("Unavailable", `${path} could not be found`) })
  if (there) yield* Effect.scoped(Effect.flatMap(opened(true), checked))
  const writer = yield* holdWriter(`${path}.writer`, path)
  const db = yield* opened(false)
  yield* Effect.try({ try: () => db.exec("PRAGMA busy_timeout = 0"), catch: refused("Unavailable", `${path} could not be set up`) })
  const fresh = yield* checked(db)
  yield* Effect.try({
    try: () => {
      db.exec("PRAGMA journal_mode = WAL")
      db.exec("PRAGMA synchronous = FULL")
      if (fresh) {
        db.exec("BEGIN IMMEDIATE")
        db.exec(SCHEMA)
        db.exec("COMMIT")
      }
    },
    catch: refused("Unavailable", `${path} could not be made a journal database`),
  })

  /** One connection call at a time: a transaction is several steps, which no other call of this handle may come between. */
  const connection = yield* Semaphore.make(1)
  const failed = (what: string) => (cause: unknown) =>
    new JournalStorageError({ reason: "Unavailable", message: `${what} in ${path}: ${messageOf(cause)}` })
  /** Read in the connection's turn. */
  const reading = <A>(what: string, work: () => Result.Result<A, JournalStorageError>) =>
    connection.withPermits(1)(Effect.flatMap(Effect.try({ try: work, catch: failed(what) }), Effect.fromResult))
  /**
   * One transaction, in the process's write lane and the connection's turn: committed when `work` succeeds, rolled
   * back when it refuses or throws.
   */
  const transaction = <A>(what: string, work: () => Result.Result<A, JournalStorageError>) => writer.lane.withPermits(1)(connection.withPermits(1)(
    Effect.try({
      try: () => {
        db.exec("BEGIN IMMEDIATE")
        const outcome = work()
        db.exec(Result.isSuccess(outcome) ? "COMMIT" : "ROLLBACK")
        return outcome
      },
      catch: failed(what),
    }).pipe(
      Effect.tapError(() => Effect.try({ try: () => db.exec("ROLLBACK"), catch: (cause) => cause }).pipe(
        Effect.catch((cause) => Effect.logDebug(`no transaction was left to roll back in ${path}`, cause)),
      )),
      Effect.flatMap(Effect.fromResult),
    ),
  ))

  const has = (id: SessionId) => db.all("SELECT id FROM sessions WHERE id = ?", [id]).length > 0
  const lastOf = (id: SessionId): Result.Result<number, JournalStorageError> => Result.map(
    Result.mapError(decodeLast(db.all("SELECT max(seq) AS last FROM events WHERE session = ?", [id])[0]), () => unreadable(`the events of ${id}`)),
    (row) => row.last ?? 0,
  )

  return JournalStorage.of({
    create: Effect.fn("journal_sqlite.create")(function* (header) {
      const text = yield* Effect.orDie(encodeHeader(header))
      yield* transaction("a session could not be created", () => {
        if (has(header.id)) return Result.fail(exists(header.id))
        db.run("INSERT INTO sessions (id, header) VALUES (?, ?)", [header.id, text])
        return Result.void
      })
    }),
    append: Effect.fn("journal_sqlite.append")(function* (id, expectedSeq, turn, event) {
      const at = yield* Clock.currentTimeMillis
      const stored: StoredEvent = { seq: Seq.make(expectedSeq + 1), at, turn, ...event }
      const text = yield* Effect.orDie(encodeEvent(stored))
      return yield* transaction("an event could not be appended", () => {
        if (!has(id)) return Result.fail(missing(id))
        return Result.flatMap(lastOf(id), (last) => {
          if (last !== expectedSeq) return Result.fail(new JournalStorageError({ reason: "SeqConflict", message: `the journal is at ${last}, not ${expectedSeq}` }))
          db.run("INSERT INTO events (session, seq, event) VALUES (?, ?, ?)", [id, stored.seq, text])
          return Result.succeed(stored)
        })
      })
    }),
    read: Effect.fn("journal_sqlite.read")(function* (id, from) {
      return yield* reading("a session could not be read", (): Result.Result<Journal, JournalStorageError> => {
        const header = Arr.head(db.all("SELECT header FROM sessions WHERE id = ?", [id]))
        if (Option.isNone(header)) return Result.fail(missing(id))
        const decoded = Result.flatMap(Result.mapError(decodeSessionRow(header.value), () => unreadable(`the session row of ${id}`)), (row) =>
          Result.mapError(decodeHeader(row.header), () => unreadable(`the header of ${id}`)))
        return Result.flatMap(decoded, (sessionHeader) => Result.flatMap(
          decodedRows(db.all("SELECT seq, event FROM events WHERE session = ? AND seq >= ? ORDER BY seq", [id, from ?? 1]), decodeEventRow, `an event row of ${id}`),
          (rows) => Result.map(
            Result.all(rows.map((row) => Result.mapError(
              Result.filterOrFail(decodeEvent(row.event), (event) => event.seq === row.seq, () => undefined),
              () => unreadable(`the event at place ${row.seq} of ${id}`),
            ))),
            (events): Journal => ({ header: sessionHeader, events }),
          ),
        ))
      })
    }),
    list: reading("the sessions could not be listed", () => Result.flatMap(
      decodedRows(db.all("SELECT header FROM sessions", []), decodeSessionRow, "a session row"),
      (rows) => Result.map(
        Result.all(rows.map((row) => Result.mapError(decodeHeader(row.header), () => unreadable("a session header")))),
        (headers) => Arr.sort(headers, byCreation),
      ),
    )).pipe(Effect.withSpan("journal_sqlite.list")),
    fork: Effect.fn("journal_sqlite.fork")(function* (header) {
      const text = yield* Effect.orDie(encodeHeader(header))
      const { of, through } = header.branch
      yield* transaction("a branch could not be made", () => {
        if (has(header.id)) return Result.fail(exists(header.id))
        if (!has(of)) return Result.fail(missing(of))
        return Result.flatMap(lastOf(of), (last) => {
          if (through > last) return Result.fail(new JournalStorageError({ reason: "SeqConflict", message: `the journal of ${of} is at ${last}, not ${through}` }))
          db.run("INSERT INTO sessions (id, header) VALUES (?, ?)", [header.id, text])
          // The events as they were stored: each row's JSON as it is, under the branch's id.
          db.run("INSERT INTO events (session, seq, event) SELECT ?, seq, event FROM events WHERE session = ? AND seq <= ?", [header.id, of, through])
          return Result.void
        })
      })
    }),
  })
}))
