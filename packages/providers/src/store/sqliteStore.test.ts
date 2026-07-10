import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Option } from "effect"
import { ConversationId, ConversationStore, StoreError } from "@xandreed/engine"
import type { AgentMessage } from "@xandreed/engine"
import { SqliteConversationStoreLive } from "./sqliteStore.js"

const freshDbPath = (): string =>
  join(mkdtempSync(join(tmpdir(), "engine-store-")), "test.db")

const withStoreAt = <A, E>(
  dbPath: string,
  run: Effect.Effect<A, E, ConversationStore>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      run.pipe(Effect.provide(SqliteConversationStoreLive(dbPath))),
    ) as Effect.Effect<A, E>,
  )

const withStore = <A, E>(
  run: Effect.Effect<A, E, ConversationStore>,
): Promise<A> => withStoreAt(freshDbPath(), run)

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

  test("fork of an unknown conversation is a typed StoreError naming the id", async () => {
    await withStore(
      Effect.gen(function* () {
        const store = yield* ConversationStore
        const ghost = ConversationId.make(crypto.randomUUID())
        const outcome = yield* Effect.either(store.fork(ghost))
        expect(outcome._tag).toBe("Left")
        if (outcome._tag === "Left") {
          expect(outcome.left).toBeInstanceOf(StoreError)
          expect(outcome.left.message).toContain("not found")
          expect(outcome.left.message).toContain(ghost)
        }
      }),
    )
  })

  test("open stamps user_version, creates the v2 indices, and is owner-only", async () => {
    const dbPath = freshDbPath()
    await withStoreAt(
      dbPath,
      Effect.gen(function* () {
        const store = yield* ConversationStore
        yield* store.create("/ws")
      }),
    )
    expect(statSync(dbPath).mode & 0o777).toBe(0o600)
    const raw = new Database(dbPath)
    const version = (raw.query("PRAGMA user_version").get() as { user_version: number })
      .user_version
    expect(version).toBeGreaterThanOrEqual(2)
    const indices = (
      raw
        .query(`SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'`)
        .all() as ReadonlyArray<{ name: string }>
    ).map((row) => row.name)
    expect(indices).toContain("checkpoints_by_conversation")
    expect(indices).toContain("conversations_by_workspace")
    raw.close()
    // Re-opening an already-migrated db is a no-op (idempotent step 1,
    // slice past the recorded version) — the store still works.
    await withStoreAt(
      dbPath,
      Effect.gen(function* () {
        const store = yield* ConversationStore
        expect(yield* store.listByWorkspace("/ws")).toHaveLength(1)
      }),
    )
  })

  test("prune removes whole conversations older than the cutoff, nothing newer", async () => {
    await withStore(
      Effect.gen(function* () {
        const store = yield* ConversationStore
        const old = yield* store.create("/ws")
        yield* store.append(old, user("ancient"))
        yield* store.checkpoint(old, "OLD FOLD")
        const cutoff = Date.now() + 1
        yield* Effect.sleep("5 millis")
        const fresh = yield* store.create("/ws")
        yield* store.append(fresh, user("recent"))
        expect(yield* store.prune(cutoff)).toBe(1)
        expect(yield* store.list(old)).toHaveLength(0)
        expect(Option.isNone(yield* store.latestCheckpoint(old))).toBe(true)
        const listed = yield* store.listByWorkspace("/ws")
        expect(listed).toHaveLength(1)
        expect(listed[0]!.id).toBe(fresh)
        // Idempotent: nothing older remains.
        expect(yield* store.prune(cutoff)).toBe(0)
      }),
    )
  })

  test("one undecodable row degrades to a skip — the rest of the trail loads", async () => {
    const dbPath = freshDbPath()
    await withStoreAt(
      dbPath,
      Effect.gen(function* () {
        const store = yield* ConversationStore
        const id = yield* store.create("/ws")
        yield* store.append(id, user("good-1"))
        // Corruption injected OUT OF BAND (disk damage / a future schema's
        // row) — reads must salvage around it, not brick the conversation.
        yield* Effect.sync(() => {
          const raw = new Database(dbPath)
          raw
            .query(
              `INSERT INTO messages (conversation_id, position, content, created_at)
               VALUES (?, 1, 'NOT VALID JSON {', ?)`,
            )
            .run(id, Date.now())
          raw.close()
        })
        yield* store.append(id, user("good-2"))
        const all = yield* store.list(id)
        expect(all.map((m) => (m.role === "user" ? m.content : "?"))).toEqual([
          "good-1",
          "good-2",
        ])
        expect(yield* store.listActive(id)).toHaveLength(2)
        // The workspace listing survives a corrupt FIRST row too.
        const listed = yield* store.listByWorkspace("/ws")
        expect(listed).toHaveLength(1)
      }),
    )
  })
})
