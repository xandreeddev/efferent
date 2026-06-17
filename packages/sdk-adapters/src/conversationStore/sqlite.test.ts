import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { type AgentMessage, ConversationStore } from "@efferent/sdk-core"
import { SqliteConversationStoreLive } from "./sqlite.js"
import sqlite0001 from "../database/migrations-sqlite/0001_init.js"
import sqlite0005 from "../database/migrations-sqlite/0005_conversation_title.js"

// Exercises the real SQLite store + the position/checkpoint fold contract on a
// fresh in-memory db (no Postgres, no Docker). `provideMerge` exposes the
// SqlClient alongside the store so we can run the schema migration directly —
// avoiding the migrator's platform FileSystem requirement (the app provides
// BunContext for that at its composition root).
const Live = SqliteConversationStoreLive.pipe(
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
)

const user = (content: string): AgentMessage => ({ role: "user", content })

const run = <A>(eff: Effect.Effect<A, unknown, ConversationStore>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* sqlite0001 // create the schema on this connection
      yield* sqlite0005 // + the conversations.title column
      return yield* eff
    }).pipe(Effect.provide(Live)) as Effect.Effect<A>,
  )

describe("SqliteConversationStore", () => {
  test("create + append + list preserves order; listActive == list with no checkpoint", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* ConversationStore
        const id = yield* store.create("/tmp/ws")
        yield* store.append(id, user("a"))
        yield* store.append(id, user("b"))
        yield* store.append(id, user("c"))
        return { all: yield* store.list(id), active: yield* store.listActive(id) }
      }),
    )
    expect(result.all.map((m) => (m.role === "user" ? m.content : ""))).toEqual(["a", "b", "c"])
    expect(result.active).toHaveLength(3)
  })

  test("checkpoint folds up to head; listActive returns only later rows; originals untouched", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* ConversationStore
        const id = yield* store.create()
        yield* store.append(id, user("a")) // position 0
        yield* store.append(id, user("b")) // position 1
        yield* store.checkpoint(id, "SUMMARY") // folds at position 1
        yield* store.append(id, user("c")) // position 2
        return {
          cp: yield* store.getLatestCheckpoint(id),
          active: yield* store.listActive(id),
          all: yield* store.list(id),
        }
      }),
    )
    expect(result.cp?.summary).toBe("SUMMARY")
    expect(result.cp?.messagePosition).toBe(1)
    expect(result.all).toHaveLength(3)
    expect(result.active.map((m) => (m.role === "user" ? m.content : ""))).toEqual(["c"])
  })

  test("getLatestCheckpoint returns most recent; listCheckpoints is position-sorted", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* ConversationStore
        const id = yield* store.create()
        yield* store.append(id, user("a"))
        yield* store.checkpoint(id, "S1") // position 0
        yield* store.append(id, user("b"))
        yield* store.checkpoint(id, "S2") // position 1
        return { latest: yield* store.getLatestCheckpoint(id), list: yield* store.listCheckpoints(id) }
      }),
    )
    expect(result.latest?.summary).toBe("S2")
    expect(result.list.map((c) => c.summary)).toEqual(["S1", "S2"])
  })

  test("listByWorkspace returns conversations newest-first with the first user prompt", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* ConversationStore
        const id = yield* store.create("/tmp/ws-a")
        yield* store.append(id, user("hello world"))
        return yield* store.listByWorkspace("/tmp/ws-a")
      }),
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.firstPrompt).toBe("hello world")
  })

  test("setTitle round-trips through listByWorkspace; untitled rows omit the field", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* ConversationStore
        const untitled = yield* store.create("/tmp/ws-t")
        const titled = yield* store.create("/tmp/ws-t")
        yield* store.append(titled, user("name me"))
        yield* store.setTitle(titled, "Fix the parser")
        return { rows: yield* store.listByWorkspace("/tmp/ws-t"), titled, untitled }
      }),
    )
    const byId = new Map(result.rows.map((r) => [r.id, r]))
    expect(byId.get(result.titled)?.title).toBe("Fix the parser")
    expect(byId.get(result.untitled)?.title).toBeUndefined()
  })

  test("setTitle on a missing conversation fails with ConversationNotFound", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        yield* sqlite0001
        yield* sqlite0005
        const store = yield* ConversationStore
        yield* store.setTitle("00000000-0000-0000-0000-000000000000" as never, "x")
      }).pipe(Effect.provide(Live)),
    )
    expect(exit._tag).toBe("Failure")
  })

  test("append to a missing conversation fails with ConversationNotFound", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        yield* sqlite0001
        const store = yield* ConversationStore
        yield* store.append("00000000-0000-0000-0000-000000000000" as never, user("x"))
      }).pipe(Effect.provide(Live)),
    )
    expect(exit._tag).toBe("Failure")
  })
})
