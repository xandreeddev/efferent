import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Option } from "effect"
import { ConversationId, ConversationStore, SessionLog, SessionStore } from "@xandreed/core"
import { SessionStoreProjectionLive } from "./compatibility.adapter.js"
import { SessionLogSqliteLive } from "./session-log.adapter.js"
import { ConversationStoreProjectionLive } from "./store/sqliteStore.js"

const directories: string[] = []
const directory = () => { const path = mkdtempSync(join(tmpdir(), "efferent-legacy-import-")); directories.push(path); return path }
afterEach(() => directories.splice(0).forEach((path) => rmSync(path, { force: true, recursive: true })))
const harnessId = ConversationId.make("00000000-0000-4000-8000-000000000001")
const conversationId = ConversationId.make("00000000-0000-4000-8000-000000000002")
const legacyRecord = { id: harnessId, workspace: "/workspace", profile: "custom", createdAt: 100 }
const legacyEvents = [
  { version: 1 as const, id: "legacy-start", sessionId: harnessId, seq: 0, at: 101, name: "run.started", runId: "old-run", data: {} },
  { version: 1 as const, id: "legacy-end", sessionId: harnessId, seq: 1, at: 102, name: "run.completed", runId: "old-run", data: { text: "old answer", outcome: "completed" } },
]
const seed = (path: string, events = legacyEvents) => {
  const db = new Database(path)
  db.exec(`
    CREATE TABLE harness_sessions (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE harness_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(session_id, seq));
    CREATE TABLE conversations (id TEXT PRIMARY KEY, workspace_dir TEXT, title TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE messages (conversation_id TEXT NOT NULL, position INTEGER NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(conversation_id, position));
    CREATE TABLE checkpoints (conversation_id TEXT NOT NULL, message_position INTEGER NOT NULL, summary TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE run_outcomes (conversation_id TEXT NOT NULL, at INTEGER NOT NULL, outcome TEXT NOT NULL, reason TEXT NOT NULL);
    PRAGMA user_version = 3;
  `)
  db.query("INSERT INTO harness_sessions VALUES (?, ?, ?)").run(harnessId, "/workspace", JSON.stringify(legacyRecord))
  events.forEach((event) => db.query("INSERT INTO harness_events VALUES (?, ?, ?)").run(harnessId, event.seq, JSON.stringify(event)))
  db.query("INSERT INTO conversations VALUES (?, '/workspace', 'Old title', 100)").run(conversationId)
  const contents = [JSON.stringify({ role: "user", content: "old prompt" }), "NOT JSON", JSON.stringify({ role: "user", content: "newer prompt" })]
  contents.forEach((content, position) => db.query("INSERT INTO messages VALUES (?, ?, ?, ?)").run(conversationId, position, content, 103 + position))
  db.query("INSERT INTO checkpoints VALUES (?, 1, 'OLD FOLD', 106)").run(conversationId)
  db.query("INSERT INTO run_outcomes VALUES (?, 107, 'partial', 'step-cap')").run(conversationId)
  db.close()
}
const withStores = <A, E>(path: string, program: Effect.Effect<A, E, SessionStore | ConversationStore | SessionLog>, legacyPaths: ReadonlyArray<string> = [], legacyOwner = "conversation-store") => Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(
  Layer.merge(SessionStoreProjectionLive, ConversationStoreProjectionLive()).pipe(Layer.provideMerge(SessionLogSqliteLive(path, { legacyPaths, legacyOwner }))),
))))

describe("legacy journals migrate into the unified session log", () => {
  test("imports local tables once, preserves original rows and positions, and writes only the log thereafter", async () => {
    const path = join(directory(), "sessions.db")
    seed(path)
    await withStores(path, Effect.gen(function* () {
      const harness = yield* SessionStore
      const conversations = yield* ConversationStore
      expect(yield* harness.get(harnessId)).toEqual(legacyRecord)
      expect(yield* harness.read(harnessId, -1)).toEqual(legacyEvents)
      expect((yield* conversations.listActive(conversationId)).map((row) => row.position)).toEqual([2])
      expect(Option.getOrThrow(yield* conversations.latestCheckpoint(conversationId)).summary).toBe("OLD FOLD")
      expect(Option.getOrThrow(yield* conversations.latestOutcome(conversationId)).outcome).toBe("partial")
      expect(Option.getOrThrow((yield* conversations.listByWorkspace("/workspace")).find((summary) => summary.id === conversationId)!.title)).toBe("Old title")
      expect((yield* harness.append(harnessId, { name: "answer", data: { text: "new answer" } })).seq).toBe(2)
      expect(yield* conversations.append(conversationId, { role: "user", content: "fresh prompt" })).toBe(3)
    }))
    await withStores(path, Effect.gen(function* () {
      expect((yield* (yield* SessionStore).read(harnessId, -1)).length).toBe(3)
      expect((yield* (yield* ConversationStore).list(conversationId)).map((message) => message.content)).toEqual(["old prompt", "newer prompt", "fresh prompt"])
    }))
    const raw = new Database(path, { readonly: true })
    expect(raw.query("SELECT body FROM harness_events ORDER BY seq").all()).toEqual(legacyEvents.map((event) => ({ body: JSON.stringify(event) })))
    expect(raw.query("SELECT count(*) AS count FROM messages").get()).toEqual({ count: 3 })
    expect(raw.query("PRAGMA user_version").get()).toEqual({ user_version: 3 })
    expect(raw.query("SELECT count(*) AS count FROM session_log_imports").get()).toEqual({ count: 1 })
    raw.close()
  })

  test("concurrent initialization imports a separate source once and leaves it byte-for-byte unchanged", async () => {
    const dir = directory()
    const source = join(dir, "old.db")
    const destination = join(dir, "sessions.db")
    seed(source)
    chmodSync(source, 0o400)
    const before = readFileSync(source)
    const read = Effect.gen(function* () {
      const log = yield* SessionLog
      expect((yield* log.head(harnessId)).seq).toBe(2)
      expect((yield* log.read(conversationId, { after: 0, kinds: [], limit: Option.none() })).map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6])
    })
    await Promise.all([withStores(destination, read, [source, join(dir, ".", "old.db")]), withStores(destination, read, [source])])
    expect(readFileSync(source)).toEqual(before)
    expect(statSync(source).mode & 0o777).toBe(0o400)
    await withStores(destination, read, [source])
    const raw = new Database(destination, { readonly: true })
    expect(raw.query("SELECT count(*) AS count FROM session_log_imports").get()).toEqual({ count: 2 })
    raw.close()
  })

  test("a failed import rolls back every imported row and can be retried after repairing the source", async () => {
    const dir = directory()
    const source = join(dir, "old.db")
    const destination = join(dir, "sessions.db")
    seed(source)
    const damaged = new Database(source)
    damaged.exec("DROP TABLE messages")
    damaged.close()
    const failure = await withStores(destination, Effect.succeed("opened"), [source]).then(() => "unexpected success", (error: unknown) => String(error))
    expect(failure).toContain("no such table: messages")
    const destinationDb = new Database(destination, { readonly: true })
    expect(destinationDb.query("SELECT count(*) AS count FROM session_heads").get()).toEqual({ count: 0 })
    expect(destinationDb.query("SELECT count(*) AS count FROM session_log_imports WHERE source != 'local'").get()).toEqual({ count: 0 })
    destinationDb.close()
    const repaired = new Database(source)
    repaired.exec("CREATE TABLE messages (conversation_id TEXT NOT NULL, position INTEGER NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)")
    repaired.close()
    await withStores(destination, Effect.gen(function* () {
      expect((yield* (yield* SessionStore).read(harnessId, -1)).length).toBe(2)
    }), [source])
  })

  test("removing migrated sessions cannot resurrect them on reopening", async () => {
    const dir = directory()
    const source = join(dir, "old.db")
    const destination = join(dir, "sessions.db")
    seed(source)
    await withStores(destination, Effect.gen(function* () {
      yield* (yield* SessionLog).remove(conversationId)
    }), [source])
    await withStores(destination, Effect.gen(function* () {
      expect(yield* (yield* ConversationStore).list(conversationId)).toEqual([])
      expect((yield* Effect.result((yield* SessionLog).head(conversationId)))._tag).toBe("Failure")
    }), [source])
  })

  test("legacy cursors remain valid when historical positions have gaps", async () => {
    const path = join(directory(), "sessions.db")
    seed(path, legacyEvents.map((event, index) => ({ ...event, seq: 10 + index * 2 })))
    await withStores(path, Effect.gen(function* () {
      const store = yield* SessionStore
      expect((yield* store.read(harnessId, 10)).map((event) => event.seq)).toEqual([12])
      expect((yield* store.append(harnessId, { name: "later", data: {} })).seq).toBe(13)
      expect((yield* store.read(harnessId, 12)).map((event) => event.seq)).toEqual([13])
    }))
  })

  test("forking an inherited historical boundary copies exactly that prefix", async () => {
    const path = join(directory(), "sessions.db")
    await withStores(path, Effect.gen(function* () {
      const store = yield* SessionStore
      const root = yield* store.create("/workspace", "custom")
      yield* Effect.forEach(Array.from({ length: 6 }, (_, index) => index), (index) => store.append(root.id, { name: `event-${index}`, data: {} }))
      const branch = yield* store.fork(root.id, 5)
      const earlier = yield* store.fork(branch.id, 2)
      expect(earlier.parent).toBe(branch.id)
      expect((yield* store.read(earlier.id, -1)).map((event) => event.name)).toEqual(["event-0", "event-1", "event-2"])
      yield* store.append(root.id, { name: "future-parent", data: {} })
      yield* store.append(branch.id, { name: "future-branch", data: {} })
      expect((yield* store.append(earlier.id, { name: "own", data: {} })).seq).toBe(3)
      expect((yield* store.read(earlier.id, 2)).map((event) => event.name)).toEqual(["own"])
      expect((yield* store.read(root.id, -1)).length).toBe(7)
    }))
  })

  test("a conflicting owner refuses the whole import and preserves the destination", async () => {
    const dir = directory()
    const source = join(dir, "old.db")
    const destination = join(dir, "sessions.db")
    seed(source)
    await withStores(destination, Effect.gen(function* () {
      yield* (yield* SessionLog).create({ id: harnessId, owner: "/different-workspace", origin: "harness", createdAt: 100, meta: {}, parent: Option.none() })
    }))
    const failure = await withStores(destination, Effect.succeed("opened"), [source]).then(() => "unexpected success", (error: unknown) => String(error))
    expect(failure).toContain("conflicting legacy identity")
    await withStores(destination, Effect.gen(function* () {
      const log = yield* SessionLog
      expect((yield* log.head(harnessId)).header.owner).toBe("/different-workspace")
      expect((yield* log.head(harnessId)).seq).toBe(0)
      expect((yield* Effect.result(log.head(conversationId)))._tag).toBe("Failure")
    }))
  })

  test("a conflicting historical position refuses the source, while equivalent source copies do not duplicate events", async () => {
    const dir = directory()
    const source = join(dir, "old.db")
    const destination = join(dir, "sessions.db")
    seed(source, legacyEvents.map((event) => ({ ...event, id: `different-${event.id}` })))
    seed(destination)
    await withStores(destination, Effect.void)
    const failure = await withStores(destination, Effect.succeed("opened"), [source]).then(() => "unexpected success", (error: unknown) => String(error))
    expect(failure).toContain("conflicting legacy position")
    const repaired = new Database(source)
    legacyEvents.forEach((event) => repaired.query("UPDATE harness_events SET body = ? WHERE session_id = ? AND seq = ?").run(JSON.stringify(event), harnessId, event.seq))
    repaired.close()
    await withStores(destination, Effect.gen(function* () {
      const log = yield* SessionLog
      expect((yield* log.head(harnessId)).seq).toBe(2)
      expect((yield* log.head(conversationId)).seq).toBe(6)
    }), [source])
  })

  test("imports historical domain messages written under a harness id without a conversation row", async () => {
    const path = join(directory(), "sessions.db")
    seed(path)
    const legacy = new Database(path)
    legacy.query("DELETE FROM conversations").run()
    legacy.query("UPDATE messages SET conversation_id = ?").run(harnessId)
    legacy.query("UPDATE checkpoints SET conversation_id = ?").run(harnessId)
    legacy.query("UPDATE run_outcomes SET conversation_id = ?").run(harnessId)
    legacy.close()
    await withStores(path, Effect.gen(function* () {
      const store = yield* ConversationStore
      expect((yield* store.list(harnessId)).map((message) => message.content)).toEqual(["old prompt", "newer prompt"])
      expect((yield* store.listActive(harnessId)).map((row) => row.position)).toEqual([2])
      expect((yield* (yield* SessionLog).head(harnessId)).header.owner).toBe("/workspace")
      expect((yield* (yield* SessionStore).read(harnessId, -1)).length).toBe(2)
    }))
  })

  test("orphan source messages cannot borrow a destination owner's identity", async () => {
    const dir = directory()
    const source = join(dir, "old.db")
    const destination = join(dir, "sessions.db")
    seed(source)
    const legacy = new Database(source)
    legacy.query("DELETE FROM conversations").run()
    legacy.close()
    await withStores(destination, Effect.gen(function* () {
      yield* (yield* SessionLog).create({ id: conversationId, owner: "/different-workspace", origin: "harness", createdAt: 100, meta: {}, parent: Option.none() })
    }))
    const failure = await withStores(destination, Effect.void, [source], "/workspace").then(() => "unexpected success", (error: unknown) => String(error))
    expect(failure).toContain("conflicting legacy identity")
    await withStores(destination, Effect.gen(function* () {
      expect((yield* (yield* SessionLog).head(conversationId)).seq).toBe(0)
    }))
    await withStores(destination, Effect.gen(function* () {
      const log = yield* SessionLog
      yield* log.remove(conversationId)
      yield* log.create({ id: conversationId, owner: "/workspace", origin: "harness", createdAt: 100, meta: {}, parent: Option.none() })
    }))
    await withStores(destination, Effect.gen(function* () {
      expect((yield* (yield* ConversationStore).list(conversationId)).map((message) => message.content)).toEqual(["old prompt", "newer prompt"])
    }), [source], "/workspace")
  })
})
