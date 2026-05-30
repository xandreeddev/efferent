import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { type AgentMessage, ConversationStore } from "@agent/core"
import { InMemoryConversationStoreLive } from "./inMemoryConversationStore.js"

const user = (content: string): AgentMessage => ({ role: "user", content })

const run = <A>(eff: Effect.Effect<A, unknown, ConversationStore>): Promise<A> =>
  Effect.runPromise(eff.pipe(Effect.provide(InMemoryConversationStoreLive)) as Effect.Effect<A>)

describe("InMemoryConversationStore", () => {
  test("create + append + list preserves order; listActive == list with no checkpoint", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* ConversationStore
        const id = yield* store.create("/tmp/ws")
        yield* store.append(id, user("a"))
        yield* store.append(id, user("b"))
        yield* store.append(id, user("c"))
        const all = yield* store.list(id)
        const active = yield* store.listActive(id)
        return { all, active }
      }),
    )
    expect(result.all.map((m) => (m.role === "user" ? m.content : ""))).toEqual(["a", "b", "c"])
    expect(result.active).toHaveLength(3)
  })

  test("checkpoint folds everything up to head; listActive returns only later rows", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* ConversationStore
        const id = yield* store.create()
        yield* store.append(id, user("a")) // position 0
        yield* store.append(id, user("b")) // position 1
        yield* store.checkpoint(id, "SUMMARY") // folds at position 1
        yield* store.append(id, user("c")) // position 2
        const cp = yield* store.getLatestCheckpoint(id)
        const active = yield* store.listActive(id)
        const all = yield* store.list(id)
        return { cp, active, all }
      }),
    )
    expect(result.cp?.summary).toBe("SUMMARY")
    expect(result.cp?.messagePosition).toBe(1)
    expect(result.all).toHaveLength(3) // originals untouched
    expect(result.active.map((m) => (m.role === "user" ? m.content : ""))).toEqual(["c"])
  })

  test("getLatestCheckpoint returns the most recent; listCheckpoints is position-sorted", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* ConversationStore
        const id = yield* store.create()
        yield* store.append(id, user("a"))
        yield* store.checkpoint(id, "S1") // position 0
        yield* store.append(id, user("b"))
        yield* store.checkpoint(id, "S2") // position 1
        const latest = yield* store.getLatestCheckpoint(id)
        const list = yield* store.listCheckpoints(id)
        return { latest, list }
      }),
    )
    expect(result.latest?.summary).toBe("S2")
    expect(result.list.map((c) => c.summary)).toEqual(["S1", "S2"])
  })

  test("append to a missing conversation fails with ConversationNotFound", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const store = yield* ConversationStore
        // a syntactically valid but unknown UUID
        yield* store.append(
          "00000000-0000-0000-0000-000000000000" as never,
          user("x"),
        )
      }).pipe(Effect.provide(InMemoryConversationStoreLive)),
    )
    expect(exit._tag).toBe("Failure")
  })
})
