import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Option } from "effect"
import { ConversationStore } from "@xandreed/engine"
import type { AgentMessage } from "@xandreed/engine"
import { SqliteConversationStoreLive } from "./sqliteStore.js"

const withStore = <A, E>(
  run: Effect.Effect<A, E, ConversationStore>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      run.pipe(
        Effect.provide(
          SqliteConversationStoreLive(
            join(mkdtempSync(join(tmpdir(), "engine-store-")), "test.db"),
          ),
        ),
      ),
    ) as Effect.Effect<A, E>,
  )

const user = (content: string): AgentMessage => ({ role: "user", content })

describe("SqliteConversationStoreLive", () => {
  test("append assigns monotonic positions from 0; list returns in order", async () => {
    await withStore(
      Effect.gen(function* () {
        const store = yield* ConversationStore
        const id = yield* store.create("/ws")
        expect(yield* store.append(id, user("a"))).toBe(0)
        expect(yield* store.append(id, user("b"))).toBe(1)
        expect(yield* store.append(id, user("c"))).toBe(2)
        const all = yield* store.list(id)
        expect(all.map((m) => (m.role === "user" ? m.content : "?"))).toEqual(["a", "b", "c"])
      }),
    )
  })

  test("checkpoint folds for loading: listActive returns only rows after it", async () => {
    await withStore(
      Effect.gen(function* () {
        const store = yield* ConversationStore
        const id = yield* store.create()
        yield* store.append(id, user("old-1"))
        yield* store.append(id, user("old-2"))
        yield* store.checkpoint(id, "THE SUMMARY")
        yield* store.append(id, user("new-1"))

        const active = yield* store.listActive(id)
        expect(active).toEqual([user("new-1")])
        // list still returns EVERYTHING (originals never modified).
        expect(yield* store.list(id)).toHaveLength(3)

        const fold = yield* store.latestCheckpoint(id)
        expect(Option.isSome(fold)).toBe(true)
        expect(Option.getOrThrow(fold).summary).toBe("THE SUMMARY")
        expect(Option.getOrThrow(fold).messagePosition).toBe(1)
      }),
    )
  })

  test("no checkpoint → latestCheckpoint None, listActive = everything", async () => {
    await withStore(
      Effect.gen(function* () {
        const store = yield* ConversationStore
        const id = yield* store.create()
        yield* store.append(id, user("only"))
        expect(Option.isNone(yield* store.latestCheckpoint(id))).toBe(true)
        expect(yield* store.listActive(id)).toHaveLength(1)
      }),
    )
  })

  test("listByWorkspace surfaces title + first prompt, newest first", async () => {
    await withStore(
      Effect.gen(function* () {
        const store = yield* ConversationStore
        const a = yield* store.create("/ws")
        yield* store.append(a, user("first question"))
        yield* store.setTitle(a, "titled")
        const b = yield* store.create("/other")
        yield* store.append(b, user("elsewhere"))

        const listed = yield* store.listByWorkspace("/ws")
        expect(listed).toHaveLength(1)
        expect(Option.getOrThrow(listed[0]!.title)).toBe("titled")
        expect(Option.getOrThrow(listed[0]!.firstPrompt)).toBe("first question")
      }),
    )
  })

  test("checkpointAt folds at an EXPLICIT position; a later full checkpoint supersedes it", async () => {
    await withStore(
      Effect.gen(function* () {
        const store = yield* ConversationStore
        const id = yield* store.create()
        yield* store.append(id, user("p0"))
        yield* store.append(id, user("p1"))
        yield* store.append(id, user("p2"))
        // Mid-run fold covering rows 0..1 — row 2 stays active.
        yield* store.checkpointAt(id, "MID FOLD", 1)
        expect(yield* store.listActive(id)).toEqual([user("p2")])
        expect(Option.getOrThrow(yield* store.latestCheckpoint(id)).messagePosition).toBe(1)
        // The attempt-boundary fold (MAX position) wins as the latest.
        yield* store.checkpoint(id, "FULL FOLD")
        const latest = Option.getOrThrow(yield* store.latestCheckpoint(id))
        expect(latest.summary).toBe("FULL FOLD")
        expect(latest.messagePosition).toBe(2)
        expect(yield* store.listActive(id)).toEqual([])
      }),
    )
  })

  test("positions are per-conversation (no cross-talk)", async () => {
    await withStore(
      Effect.gen(function* () {
        const store = yield* ConversationStore
        const a = yield* store.create()
        const b = yield* store.create()
        yield* store.append(a, user("a0"))
        expect(yield* store.append(b, user("b0"))).toBe(0)
        expect(yield* store.append(a, user("a1"))).toBe(1)
      }),
    )
  })

  test("fork copies the trail (and checkpoint) into an INDEPENDENT conversation", async () => {
    await withStore(
      Effect.gen(function* () {
        const store = yield* ConversationStore
        const source = yield* store.create("/ws/fork-src")
        yield* store.append(source, { role: "user", content: "one" })
        yield* store.append(source, { role: "user", content: "two" })
        yield* store.checkpoint(source, "THE FOLD")
        yield* store.append(source, { role: "user", content: "three" })
        yield* store.setTitle(source, "original")

        const fork = yield* store.fork(source)
        const forked = yield* store.list(fork)
        expect(forked.map((m) => m.content)).toEqual(["one", "two", "three"])
        // The checkpoint rode along: listActive shows only post-fold rows.
        const active = yield* store.listActive(fork)
        expect(active.map((m) => m.content)).toEqual(["three"])
        // Independence: appending to the fork never touches the source.
        yield* store.append(fork, { role: "user", content: "fork-only" })
        const sourceRows = yield* store.list(source)
        expect(sourceRows.map((m) => m.content)).toEqual(["one", "two", "three"])
        // The fork announces its lineage in the title.
        const sessions = yield* store.listByWorkspace("/ws/fork-src")
        const titles = sessions.map((s) => Option.getOrElse(s.title, () => "(untitled)"))
        expect(titles).toContain("original")
        expect(titles).toContain("fork: original")

        // upToPosition caps the copy (branch from mid-history).
        const early = yield* store.fork(source, 0)
        const earlyRows = yield* store.list(early)
        expect(earlyRows.map((m) => m.content)).toEqual(["one"])
      }),
    )
  })
})
