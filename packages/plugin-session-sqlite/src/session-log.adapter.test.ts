import { afterAll, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { Context, Effect, Exit, Layer, Option, Scope } from "effect"
import { ConversationId, SessionLog, sessionLogConformance, sessionLogRecoveryConformance } from "@xandreed/core"
import { makeSessionLogSqlite, openSessionDatabase, SessionLogSqliteLive } from "./session-log.adapter.js"

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
