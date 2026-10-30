import { afterAll, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { Context, Effect, Exit, Layer, Option, Schema, Scope, Tracer } from "effect"
import { ConversationId, SessionHeader, SessionLog, SessionLogEvent } from "@xandreed/core"
import { sessionLogConformance, sessionLogRecoveryConformance } from "@xandreed/core/conformance"
import { makeSessionLogSqlite, migrateSessionDatabase, openSessionDatabase, SessionLogSqliteLive } from "./session-log.adapter.js"

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
      yield* damaged.create({ id, owner: "owner-damaged", origin: "user", createdAt: 1_767_225_600_000, meta: {}, parent: Option.none() })
      yield* damaged.commit(id, { expect: 0, notAfter: Option.none(), events: [{ kind: "note", turn: Option.none(), data: { n: 1 } }], state: Option.some({ ok: true }) })
      const outside = new Database(path, { strict: true })
      const damage = (sql: string) => Effect.sync(() => outside.query(sql).run())
      const codeOf = <A, E>(effect: Effect.Effect<A, E>) => Effect.exit(effect).pipe(Effect.map((exit) =>
        Exit.isSuccess(exit) ? "succeeded" : Option.match(Exit.findErrorOption(exit), {
          onNone: () => "defect",
          onSome: (error) => typeof error === "object" && error !== null && "code" in error ? String(error.code) : "other",
        })))
      yield* damage("UPDATE session_log_events SET data = '{not json'")
      const read = yield* codeOf(damaged.read(id, { after: 0, limit: Option.none(), kinds: [] }))
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
const tablesOf = (db: Database) => db.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name").all()

/**
 * The tables exactly as 0.14.0 created them, without recording a version: a
 * copy kept here, so a change to the adapter's first migration (which must
 * stay this text) fails the test that compares an opened 0.14.0 file with a
 * new one.
 */
const TABLES_0_14 = `
    CREATE TABLE IF NOT EXISTS session_heads (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, origin TEXT NOT NULL, created_at INTEGER NOT NULL, meta TEXT NOT NULL,
      parent_id TEXT REFERENCES session_heads(id) ON DELETE CASCADE, parent_through INTEGER, turn_at_fork INTEGER,
      seq INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS session_heads_owner ON session_heads(owner, updated_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS session_heads_parent ON session_heads(parent_id);
    CREATE TABLE IF NOT EXISTS session_log_events (
      session_id TEXT NOT NULL REFERENCES session_heads(id) ON DELETE CASCADE, seq INTEGER NOT NULL, turn INTEGER,
      kind TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id, seq));
    CREATE INDEX IF NOT EXISTS session_log_events_kind ON session_log_events(session_id, kind, seq);
  `

/** The sessions 0.14.0 stored (the sdk's journal fixture), decoded. */
const JournalFixture = Schema.Struct({ sessions: Schema.Array(Schema.Struct({ header: SessionHeader, events: Schema.Array(SessionLogEvent) })) })
const { sessions } = await Effect.runPromise(Schema.decodeUnknownEffect(JournalFixture)(await Bun.file(join(import.meta.dir, "../../sdk/fixtures/journal-0.14.0.json")).json()))
const lastSeq = (events: ReadonlyArray<SessionLogEvent>) => events.reduce((last, event) => Math.max(last, event.seq), 0)

describe("the SQLite file's schema version (user_version)", () => {
  test("a file 0.14.0 wrote, without a version, opens as it was: its sessions read back whole, the next commit lands, and it ends at schema 1 with a new file's tables", async () => {
    const path = join(directory, "written-by-0.14.0.db")
    const opened = await Effect.runPromise(Effect.gen(function* () {
      // The file as 0.14.0 left it: WAL, its tables, user_version 0, the fixture's sessions and events.
      const before = yield* Effect.scoped(rawDatabase(path).pipe(Effect.map((db) => {
        db.exec("PRAGMA journal_mode = WAL;")
        db.transaction(() => {
          db.exec(TABLES_0_14)
          sessions.forEach(({ header, events }) => {
            const parent = Option.getOrNull(header.parent)
            db.query("INSERT INTO session_heads (id, owner, origin, created_at, meta, parent_id, parent_through, turn_at_fork, seq, revision, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
              .run(header.id, header.owner, header.origin, header.createdAt, JSON.stringify(header.meta), parent?.id ?? null, parent?.through ?? null, parent?.turnAtFork ?? null, lastSeq(events), events.length, "{}", header.createdAt)
            const insert = db.query("INSERT INTO session_log_events (session_id, seq, turn, kind, at, data) VALUES (?, ?, ?, ?, ?, ?)")
            events.forEach((event) => insert.run(event.session, event.seq, Option.getOrNull(event.turn), event.kind, event.at, JSON.stringify(event.data)))
          })
        }).immediate()
        return userVersion(db)
      })))
      const read = yield* Effect.scoped(Effect.gen(function* () {
        const log = yield* makeSessionLogSqlite(path)
        const back = yield* Effect.forEach(sessions, ({ header }) => Effect.all({
          head: log.head(header.id),
          events: log.read(header.id, { after: 0, limit: Option.none(), kinds: [] }),
        }, { concurrency: 1 }), { concurrency: 1 })
        const [first] = back
        const committed = yield* Effect.fromNullishOr(first).pipe(Effect.flatMap(({ head }) => log.commit(head.header.id, {
          expect: head.revision, notAfter: Option.none(), events: [{ kind: "note", turn: Option.none(), data: { after: "0.14.0" } }], state: Option.none(),
        })))
        return { back, committed: committed.seq }
      }))
      const after = yield* Effect.scoped(rawDatabase(path).pipe(Effect.map((db) => ({ version: userVersion(db), tables: tablesOf(db) }))))
      const fresh = yield* Effect.scoped(openSessionDatabase(join(directory, "new-beside-0.14.0.db")).pipe(Effect.map(tablesOf)))
      return { before, read, after, fresh }
    }))
    expect(opened.before).toBe(0)
    expect(opened.read.back.map(({ head }) => [head.header, head.seq])).toEqual(sessions.map(({ header, events }) => [header, lastSeq(events)]))
    expect(opened.read.back.map(({ events }) => events)).toEqual(sessions.map(({ events }) => events))
    expect(opened.read.committed).toBe(lastSeq(sessions[0]?.events ?? []) + 1)
    expect(opened.after.version).toBe(1)
    expect(opened.after.tables).toEqual(opened.fresh)
  })

  test("a new file is at schema 1", async () => {
    const version = await Effect.runPromise(Effect.scoped(openSessionDatabase(join(directory, "new.db")).pipe(Effect.map(userVersion))))
    expect(version).toBe(1)
  })

  test("a file a newer release wrote fails to open with store.version, and is left as it was", async () => {
    const path = join(directory, "newer.db")
    const id = ConversationId.make(crypto.randomUUID())
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const log = yield* makeSessionLogSqlite(path)
      yield* log.create({ id, owner: "owner-newer", origin: "user", createdAt: 1_767_225_600_000, meta: {}, parent: Option.none() })
    })))
    await Effect.runPromise(Effect.scoped(rawDatabase(path).pipe(Effect.map((db) => db.exec("PRAGMA user_version = 2;")))))
    const bytes = await Bun.file(path).bytes()
    const error = await Effect.runPromise(Effect.flip(Effect.scoped(makeSessionLogSqlite(path))))
    expect([error._tag, error.code, error.message]).toEqual([
      "SessionLogError", "store.version", "the session database is at schema 2, written by a newer release; this release reads up to schema 1",
    ])
    expect(await Bun.file(path).bytes()).toEqual(bytes)
  })

  test("an added migration runs once, after the ones the file has; migrating again runs nothing", async () => {
    const first = "CREATE TABLE notes (text TEXT NOT NULL);"
    const second = "CREATE TABLE marks (n INTEGER NOT NULL); INSERT INTO marks VALUES (1);"
    const steps = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const db = yield* rawDatabase(join(directory, "two-steps.db"))
      yield* migrateSessionDatabase(db, [first])
      const atFirst = userVersion(db)
      db.query("INSERT INTO notes VALUES ('kept')").run()
      // Run again, `first` would fail on the table it made; `second` would insert a second mark.
      yield* migrateSessionDatabase(db, [first, second])
      yield* migrateSessionDatabase(db, [first, second])
      return { atFirst, atSecond: userVersion(db), notes: db.query("SELECT text FROM notes").all(), marks: db.query("SELECT n FROM marks").all() }
    })))
    expect(steps).toEqual({ atFirst: 1, atSecond: 2, notes: [{ text: "kept" }], marks: [{ n: 1 }] })
  })

  test("a step that fails leaves the version and the tables as they were", async () => {
    const first = "CREATE TABLE notes (text TEXT NOT NULL);"
    const broken = "CREATE TABLE marks (n INTEGER NOT NULL); INSERT INTO missing VALUES (1);"
    const outcome = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const db = yield* rawDatabase(join(directory, "failed-step.db"))
      yield* migrateSessionDatabase(db, [first])
      const error = yield* Effect.flip(migrateSessionDatabase(db, [first, broken]))
      return { code: error.code, version: userVersion(db), tables: db.query("SELECT name FROM sqlite_master ORDER BY name").all() }
    })))
    expect(outcome).toEqual({ code: "store.io", version: 1, tables: [{ name: "notes" }] })
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
      yield* traced.create({ id, owner: "owner-spans", origin: "user", createdAt: 1_767_225_600_000, meta: {}, parent: Option.none() })
      yield* traced.head(id)
      yield* traced.commit(id, { expect: 0, notAfter: Option.none(), events: [{ kind: "note", turn: Option.none(), data: { n: 1 } }], state: Option.none() })
      yield* traced.read(id, { after: 0, limit: Option.none(), kinds: [] })
      yield* traced.list({ owner: "owner-spans", parent: Option.none(), before: Option.none(), limit: 10 })
      yield* Effect.exit(traced.head(missing))
      yield* traced.remove(id)
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
