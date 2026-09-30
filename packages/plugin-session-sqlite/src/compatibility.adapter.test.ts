import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Option } from "effect"
import { ConversationStore, SessionLog, SessionStore } from "@xandreed/core"
import type { AgentMessage } from "@xandreed/core"
import { SessionStoreProjectionLive } from "./compatibility.adapter.js"
import { makeSessionLogSqlite } from "./session-log.adapter.js"
import { ConversationStoreProjectionLive } from "./store/sqliteStore.js"

const directories: string[] = []
afterEach(() => directories.splice(0).forEach((path) => rmSync(path, { force: true, recursive: true })))
const database = () => { const path = mkdtempSync(join(tmpdir(), "efferent-compatibility-")); directories.push(path); return join(path, "sessions.db") }

/** The SQLite log, counting every event its reads return. */
const countedLog = (path: string, seen: { events: number }) => Layer.effect(SessionLog, makeSessionLogSqlite(path).pipe(Effect.map((log) => SessionLog.of({
  ...log,
  read: (id, query) => log.read(id, query).pipe(Effect.tap((events) => Effect.sync(() => { seen.events += events.length }))),
}))))
const withCounted = <A, E>(program: (seen: { events: number }) => Effect.Effect<A, E, SessionStore | ConversationStore | SessionLog>) => {
  const seen = { events: 0 }
  return Effect.runPromise(Effect.scoped(program(seen).pipe(Effect.provide(Layer.merge(SessionStoreProjectionLive, ConversationStoreProjectionLive()).pipe(Layer.provideMerge(countedLog(database(), seen)))))))
}
const HISTORY = 2_000
const batches = Array.from({ length: HISTORY / 500 }, (_, batch) => batch)

describe("the compatibility projections read what they return, not the history", () => {
  test("an incremental harness read and an append read a handful of events after a long history", async () => {
    await withCounted((seen) => Effect.gen(function* () {
      const store = yield* SessionStore
      const log = yield* SessionLog
      const record = yield* store.create("/workspace", "custom")
      yield* Effect.forEach(batches, (batch) => log.head(record.id).pipe(Effect.flatMap((head) => log.commit(record.id, {
        expect: head.revision, notAfter: Option.none(), state: Option.none(),
        events: Array.from({ length: 500 }, (_, index) => batch * 500 + index).map((seq) => ({ kind: "harness.event", turn: Option.none(), data: { event: { version: 1, id: `event-${seq}`, sessionId: record.id, seq, at: 0, name: "item", data: {} } } })),
      }))), { discard: true })
      seen.events = 0
      expect((yield* store.read(record.id, HISTORY - 2)).map((event) => event.seq)).toEqual([HISTORY - 1])
      expect(seen.events).toBeLessThan(40)
      seen.events = 0
      expect((yield* store.append(record.id, { name: "later", data: {} })).seq).toBe(HISTORY)
      expect(seen.events).toBeLessThan(40)
      // A fork's own tail is found the same way; the inherited prefix is read only when asked for.
      const fork = yield* store.fork(record.id, HISTORY)
      yield* store.append(fork.id, { name: "own", data: {} })
      seen.events = 0
      expect((yield* store.read(fork.id, HISTORY)).map((event) => event.name)).toEqual(["own"])
      expect(seen.events).toBeLessThan(40)
      expect((yield* store.read(fork.id, HISTORY - 3)).map((event) => event.seq)).toEqual([HISTORY - 2, HISTORY - 1, HISTORY, HISTORY + 1])
    }))
  })

  test("a positional append reads a handful of events after a long conversation", async () => {
    await withCounted((seen) => Effect.gen(function* () {
      const store = yield* ConversationStore
      const id = yield* store.create("/workspace")
      const message = (text: string): AgentMessage => ({ role: "user", content: text })
      yield* Effect.forEach(batches, (batch) => store.appendAll(id, Array.from({ length: 500 }, (_, index) => message(`m${batch * 500 + index}`))), { discard: true })
      seen.events = 0
      expect(yield* store.appendAll(id, [message("next"), message("after")])).toEqual([HISTORY, HISTORY + 1])
      yield* store.checkpoint(id, "fold")
      expect(seen.events).toBeLessThan(80)
      expect(Option.getOrThrow(yield* store.latestCheckpoint(id)).messagePosition).toBe(HISTORY + 1)
    }))
  })
})
