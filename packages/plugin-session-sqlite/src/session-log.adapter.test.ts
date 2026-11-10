import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { Context, Effect, Exit, Layer, Option, Scope, Tracer } from "effect"
import { ConversationId, SessionLog, STORED_FORMAT } from "@xandreed/core"
import { sessionLogConformance, sessionLogRecoveryConformance } from "@xandreed/core/conformance"
import { makeSessionLogSqlite, initializeSessionDatabase, openSessionDatabase, SessionLogSqliteLive } from "./session-log.adapter.js"

const directory = join(tmpdir(), `efferent-session-log-${crypto.randomUUID()}`)
const scope = Effect.runSync(Scope.make())
const log = Context.get(await Effect.runPromise(Layer.buildWithScope(SessionLogSqliteLive(join(directory, "sessions.db")), scope)), SessionLog)
afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)).then(() => rmSync(directory, { recursive: true, force: true })))

describe("the SQLite session log conforms to the SessionLog contract", () => {
  sessionLogConformance(log).map((check) => test(check.name, async () => {
    const exit = await Effect.runPromise(Effect.result(check.run))
    expect(exit._tag === "Failure" ? exit.failure.message : "ok").toBe("ok")
  }))
})

describe("the SQLite session log keeps its data across handles, reopening and interruption", () => {
  sessionLogRecoveryConformance({ open: makeSessionLogSqlite(join(directory, "recovery.db")), callerClock: true }).map((check) => test(check.name, async () => {
    const exit = await Effect.runPromise(Effect.result(check.run))
    expect(exit._tag === "Failure" ? exit.failure.message : "ok").toBe("ok")
  }))
})

describe("the SQLite file", () => {
  test("is WAL with synchronous NORMAL, and SQLite never waits for a lock on the thread", async () => {
    const pragmas = await Effect.runPromise(Effect.scoped(openSessionDatabase(join(directory, "pragmas.db")).pipe(Effect.map((db) => ({
      journal: db.query<{ readonly journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode,
      synchronous: db.query<{ readonly synchronous: number }, []>("PRAGMA synchronous").get()?.synchronous,
      busyTimeout: db.query<{ readonly timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout,
    })))))
    // synchronous 1 is NORMAL: under WAL a commit survives a crash of the process without an fsync per commit.
    expect(pragmas).toEqual({ journal: "wal", synchronous: 1, busyTimeout: 0 })
  })

  test("a damaged row fails the call that reads it with store.decode, never with a defect", async () => {
    const path = join(directory, "damaged.db")
    const id = ConversationId.make(crypto.randomUUID())
    const failures = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const damaged = yield* makeSessionLogSqlite(path)
      yield* damaged.create({ header: { id, owner: "owner-damaged", origin: "user", createdAt: 1_767_225_600_000, meta: {}, parent: Option.none() }, state: {} })
      yield* Effect.gen(function* () { const sessionHead = yield* damaged.head(id); return yield* damaged.commit({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { expect: 0, notAfter: Option.none(), events: [{ kind: "note", turn: Option.none(), data: { n: 1 } }], state: Option.some({ ok: true }) }) })
      const outside = new Database(path, { strict: true })
      const damage = (sql: string) => Effect.sync(() => outside.query(sql).run())
      const codeOf = <A, E>(effect: Effect.Effect<A, E>) => Effect.exit(effect).pipe(Effect.map((exit) =>
        Exit.isSuccess(exit) ? "succeeded" : Option.match(Exit.findErrorOption(exit), {
          onNone: () => "defect",
          onSome: (error) => typeof error === "object" && error !== null && "code" in error ? String(error.code) : "other",
        })))
      yield* damage("UPDATE session_log_events SET data = '{not json'")
      const read = yield* codeOf(Effect.gen(function* () { const sessionHead = yield* damaged.head(id); return yield* damaged.read({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { after: 0, limit: Option.none(), kinds: [] }) }))
      yield* damage("UPDATE session_heads SET state = 'null'")
      const nullState = yield* codeOf(damaged.head(id))
      yield* damage("UPDATE session_heads SET state = '{}', meta = '{not json'")
      const head = yield* codeOf(damaged.head(id))
      const list = yield* codeOf(damaged.list({ owner: "owner-damaged", parent: Option.none(), before: Option.none(), limit: 10 }))
      outside.close()
      return { read, nullState, head, list }
    })))
    expect(failures).toEqual({ read: "store.decode", nullState: "store.decode", head: "store.decode", list: "store.decode" })
  })
})

/** A SQLite connection of the test's own, outside the adapter, for the scope. */
const rawDatabase = (path: string) =>
  Effect.acquireRelease(Effect.sync(() => new Database(path, { create: true, strict: true })), (db) => Effect.sync(() => db.close()))
const userVersion = (db: Database) => db.query<{ readonly user_version: number }, []>("PRAGMA user_version").get()?.user_version
const applicationId = (db: Database) => db.query<{ readonly application_id: number }, []>("PRAGMA application_id").get()?.application_id
const tablesOf = (db: Database) => db.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name").all()

describe("the SQLite file's schema version", () => {
  test("a new file initializes schema 3 directly and a second initialization preserves it", async () => {
    const path = join(directory, "fresh-v3.db")
    const outcome = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const db = yield* openSessionDatabase(path)
      const before = tablesOf(db)
      yield* initializeSessionDatabase(db)
      return { version: userVersion(db), same: JSON.stringify(tablesOf(db)) === JSON.stringify(before) }
    })))
    expect(outcome).toEqual({ version: 3, same: true })
  })

  test("a new file records the stored format it holds in its application id", async () => {
    const path = join(directory, "fresh-format.db")
    const recorded = await Effect.runPromise(Effect.scoped(openSessionDatabase(path).pipe(Effect.map(applicationId))))
    expect(recorded).toBe(STORED_FORMAT)
  })

  /** A schema-3 file whose application id reads `format` (0: none recorded), its connection closed. */
  const atFormat = async (name: string, format: number) => {
    const path = join(directory, name)
    await Effect.runPromise(Effect.scoped(openSessionDatabase(path)))
    await Effect.runPromise(Effect.scoped(rawDatabase(path).pipe(Effect.map((db) => db.exec(`PRAGMA journal_mode = DELETE; PRAGMA application_id = ${format}`)))))
    return path
  }

  test.each([STORED_FORMAT - 1, STORED_FORMAT + 1])("a schema-3 file that records stored format %s is refused with store.version without changing its bytes", async (format) => {
    const path = await atFormat(`format-${format}.db`, format)
    const before = await Bun.file(path).bytes()
    const error = await Effect.runPromise(Effect.flip(Effect.scoped(openSessionDatabase(path))))
    expect([error._tag, error.code, error.message.includes(String(format))]).toEqual(["SessionLogError", "store.version", true])
    expect(await Bun.file(path).bytes()).toEqual(before)
  })

  test("a schema-3 file that records no stored format, as the first schema-3 release wrote it, opens as format 19 and is left unrecorded", async () => {
    const path = await atFormat("unrecorded.db", 0)
    const opened = await Effect.runPromise(Effect.scoped(openSessionDatabase(path).pipe(Effect.map(applicationId), Effect.exit)))
    expect(STORED_FORMAT === 19 ? opened._tag === "Success" && opened.value : opened._tag).toBe(STORED_FORMAT === 19 ? 0 : "Failure")
  })

  test.each([0, 1, 2, 4])("unsupported existing schema %s is refused without changing its data", async (version) => {
    const path = join(directory, `unsupported-${version}.db`)
    await Effect.runPromise(Effect.scoped(rawDatabase(path).pipe(Effect.map((db) => {
      db.exec("CREATE TABLE kept (value TEXT NOT NULL); INSERT INTO kept VALUES ('preserved');")
      db.exec(`PRAGMA user_version = ${version}`)
    }))))
    const before = await Bun.file(path).bytes()
    const error = await Effect.runPromise(Effect.flip(Effect.scoped(openSessionDatabase(path))))
    expect([error._tag, error.code]).toEqual(["SessionLogError", "store.version"])
    expect(await Bun.file(path).bytes()).toEqual(before)
  })

  test("an unsupported WAL database a stopped writer left is refused without changing its mode, its WAL or its main file", async () => {
    const path = join(directory, "unsupported-wal.db")
    mkdirSync(directory, { recursive: true })
    // A writer killed after its commit: the frames stay in the WAL, never checkpointed into the main file.
    const writer = Bun.spawnSync([process.execPath, "-e", `
      import { Database } from "bun:sqlite"
      const db = new Database(${JSON.stringify(path)}, { create: true, strict: true })
      db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;")
      db.exec("CREATE TABLE kept (value TEXT NOT NULL); INSERT INTO kept VALUES ('preserved'); PRAGMA user_version = 2;")
      process.kill(process.pid, "SIGKILL")
    `])
    expect(writer.signalCode).toBe("SIGKILL")
    chmodSync(path, 0o644)
    const before = { mode: statSync(path).mode & 0o777, main: await Bun.file(path).bytes(), wal: statSync(`${path}-wal`).size }
    expect(before.wal).toBeGreaterThan(0)
    const error = await Effect.runPromise(Effect.flip(Effect.scoped(openSessionDatabase(path))))
    expect([error._tag, error.code]).toEqual(["SessionLogError", "store.version"])
    Bun.gc(true)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect({ mode: statSync(path).mode & 0o777, main: await Bun.file(path).bytes(), wal: existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : -1 }).toEqual(before)
  })
})

describe("the SQLite session log's spans", () => {
  test("opening and each call is a session_log span under the caller's, with efferent.session.id when the call names a session", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      },
    })
    const id = ConversationId.make(crypto.randomUUID())
    const missing = ConversationId.make(crypto.randomUUID())
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const traced = yield* makeSessionLogSqlite(join(directory, "spans.db"))
      const created = yield* traced.create({ header: { id, owner: "owner-spans", origin: "user", createdAt: 1_767_225_600_000, meta: {}, parent: Option.none() }, state: {} })
      const reference = { id, owner: created.header.owner, incarnation: created.incarnation }
      yield* traced.head(id)
      yield* traced.commit(reference, { expect: 0, notAfter: Option.none(), events: [{ kind: "note", turn: Option.none(), data: { n: 1 } }], state: Option.none() })
      yield* traced.read(reference, { after: 0, limit: Option.none(), kinds: [] })
      yield* traced.list({ owner: "owner-spans", parent: Option.none(), before: Option.none(), limit: 10 })
      yield* Effect.exit(traced.head(missing))
      yield* traced.remove(reference)
    })).pipe(Effect.withSpan("host.request"), Effect.withTracer(tracer)))
    const host = spans.find((span) => span.name === "host.request")
    const calls = spans.filter((span) => span !== host)
    expect(calls.map((span) => [span.name, span.attributes.get("efferent.session.id")])).toEqual([
      ["session_log.open", undefined],
      ["session_log.create", id],
      ["session_log.head", id],
      ["session_log.commit", id],
      ["session_log.read", id],
      ["session_log.list", undefined],
      ["session_log.head", missing],
      ["session_log.remove", id],
    ])
    expect(calls.every((span) => Option.exists(span.parent, (parent) => parent === host))).toBe(true)
    expect(calls.map((span) => span.status._tag === "Ended" && Exit.isFailure(span.status.exit))).toEqual([false, false, false, false, false, false, true, false])
  })
})
