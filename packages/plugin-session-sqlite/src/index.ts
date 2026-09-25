import { Database } from "bun:sqlite"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { ConversationId, definePlugin, HarnessError, SessionEvent, SessionRecord, SessionStore } from "@xandreed/core"

const Config = Schema.Struct({ path: Schema.String })
const decodeRecord = Schema.decodeUnknownSync(Schema.parseJson(SessionRecord))
const decodeEvent = Schema.decodeUnknownSync(Schema.parseJson(SessionEvent))

export const SessionStoreLive = (path: string) => Layer.scoped(SessionStore, Effect.gen(function* () {
  yield* Effect.tryPromise({ try: () => mkdir(dirname(path), { recursive: true }), catch: (error) => new HarnessError({ code: "store.open", message: String(error) }) })
  const db = yield* Effect.acquireRelease(
    Effect.try({ try: () => new Database(path, { create: true, strict: true }), catch: (error) => new HarnessError({ code: "store.open", message: String(error) }) }),
    (database) => Effect.sync(() => database.close()),
  )
  const operation = <A>(work: () => A) => Effect.try({ try: work, catch: (error) => new HarnessError({ code: "store.io", message: String(error) }) })
  yield* operation(() => db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS harness_sessions (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS harness_events (session_id TEXT NOT NULL REFERENCES harness_sessions(id), seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(session_id, seq));
  `))
  const insert = (record: SessionRecord) => {
    db.query("INSERT INTO harness_sessions VALUES (?, ?, ?)").run(record.id, record.workspace, JSON.stringify(record))
    return record
  }
  const get = (id: ConversationId) => operation(() => db.query<{ body: string }, [string]>("SELECT body FROM harness_sessions WHERE id = ?").get(id)).pipe(
    Effect.flatMap((row) => row === null
      ? Effect.fail(new HarnessError({ code: "session.missing", message: `Session ${id} does not exist` }))
      : operation(() => decodeRecord(row.body))),
  )
  const read = (id: ConversationId, after: number) => get(id).pipe(Effect.zipRight(operation(() =>
    db.query<{ body: string }, [string, number]>("SELECT body FROM harness_events WHERE session_id = ? AND seq > ? ORDER BY seq").all(id, after).map((row) => decodeEvent(row.body)),
  )))
  return SessionStore.of({
    create: (workspace, profile) => operation(() => insert({ id: ConversationId.make(crypto.randomUUID()), workspace, profile, createdAt: Date.now() })),
    get,
    list: (workspace) => operation(() => db.query<{ body: string }, [string]>("SELECT body FROM harness_sessions WHERE workspace = ? ORDER BY rowid DESC").all(workspace).map((row) => decodeRecord(row.body))),
    read,
    append: (id, body) => get(id).pipe(Effect.zipRight(operation(() => db.transaction(() => {
      const row = db.query<{ seq: number }, [string]>("SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM harness_events WHERE session_id = ?").get(id)
      const event: SessionEvent = { ...body, version: 1, id: crypto.randomUUID(), sessionId: id, seq: row?.seq ?? 0, at: Date.now() }
      db.query("INSERT INTO harness_events VALUES (?, ?, ?)").run(id, event.seq, JSON.stringify(event))
      return event
    })()))),
    fork: (id, through) => Effect.gen(function* () {
      const parent = yield* get(id)
      const trail = (yield* read(id, -1)).filter((event) => event.seq <= through)
      const active = trail.reduce((runs, event) => {
        if (event.runId === undefined) return runs
        if (event.name === "run.started") return [...runs, event.runId]
        if (["run.completed", "run.failed", "run.cancelled"].includes(event.name)) return runs.filter((run) => run !== event.runId)
        return runs
      }, [] as ReadonlyArray<string>)
      if (active.length > 0) return yield* Effect.fail(new HarnessError({ code: "session.fork-boundary", message: "Fork at a settled turn boundary" }))
      return yield* operation(() => db.transaction(() => {
        const record = insert({ ...parent, id: ConversationId.make(crypto.randomUUID()), parent: id, createdAt: Date.now() })
        trail.forEach((event, seq) => db.query("INSERT INTO harness_events VALUES (?, ?, ?)").run(record.id, seq, JSON.stringify({ ...event, sessionId: record.id, id: crypto.randomUUID(), seq })))
        return record
      })())
    }),
  })
}))

export const sessionSqlitePlugin = definePlugin({
  id: "@xandreed/plugin-session-sqlite", version: "0.4.0", scope: "runtime",
  config: Config, defaults: { path: ".efferent/runtime/sessions.db" }, provides: [SessionStore],
  layer: ({ path }) => SessionStoreLive(path),
})
export default sessionSqlitePlugin

export { SqliteConversationStoreLive } from "./store/sqliteStore.js"
