import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { AgentMessage } from "@xandreed/sdk-core"
import { messageKey, type ScrollbackBlock } from "../presentation/conversation.js"
import { projectHistory } from "../presentation/historyProjection.js"
import { createConversationSlice } from "./conversation.js"

/**
 * The conversation cache is the single source of truth for the rail, keyed by a
 * message's durable store position. These tests are the machine-checkable
 * guarantee behind the duplicate-messages fix: every writer (live event, DB
 * re-projection, optimistic submit) addresses a block by stable identity, so the
 * same logical message can't appear twice no matter how many writers touch it.
 */

const keyOf = (b: ScrollbackBlock): string | undefined =>
  b.kind === "user" || b.kind === "assistant" || b.kind === "reasoning" ? b.key : undefined

describe("keyed upsert is idempotent", () => {
  test("pushBlock with the same key twice keeps ONE entry (second wins)", () => {
    createRoot((dispose) => {
      const s = createConversationSlice()
      const key = messageKey(3, "a")
      s.pushBlock({ kind: "assistant", text: "first", key })
      s.pushBlock({ kind: "assistant", text: "second", key })
      expect(s.blocks()).toHaveLength(1)
      expect(s.blocks()[0]).toMatchObject({ kind: "assistant", text: "second" })
      dispose()
    })
  })

  test("a replayed assistant event upserts in place — no duplicate", () => {
    createRoot((dispose) => {
      const s = createConversationSlice()
      s.pushBlock({ kind: "user", text: "hi", key: messageKey(0, "u") })
      s.pushBlock({ kind: "assistant", text: "yo", key: messageKey(1, "a") })
      s.pushBlock({ kind: "assistant", text: "yo", key: messageKey(1, "a") }) // replay
      expect(s.blocks()).toHaveLength(2)
      dispose()
    })
  })

  test("keyless blocks always append (transient info/error lines)", () => {
    createRoot((dispose) => {
      const s = createConversationSlice()
      s.pushBlock({ kind: "info", text: "a" })
      s.pushBlock({ kind: "info", text: "a" })
      expect(s.blocks()).toHaveLength(2)
      dispose()
    })
  })
})

describe("optimistic ↔ authoritative reconcile", () => {
  test("resolveOptimisticUser re-keys the pending optimistic line in place", () => {
    createRoot((dispose) => {
      const s = createConversationSlice()
      s.pushOptimisticUser("run the tests")
      expect(s.blocks()).toHaveLength(1)
      s.resolveOptimisticUser(5, "run the tests")
      expect(s.blocks()).toHaveLength(1) // collapsed, not doubled
      expect(s.blocks()[0]).toMatchObject({ kind: "user", text: "run the tests", key: messageKey(5, "u") })
      dispose()
    })
  })

  test("two identical-text messages stay distinct (no content-hash merge)", () => {
    createRoot((dispose) => {
      const s = createConversationSlice()
      s.pushOptimisticUser("go")
      s.pushOptimisticUser("go")
      expect(s.blocks()).toHaveLength(2)
      s.resolveOptimisticUser(0, "go") // FIFO: claims the first
      s.resolveOptimisticUser(2, "go") // claims the second
      expect(s.blocks()).toHaveLength(2)
      expect(s.blocks().map(keyOf)).toEqual([messageKey(0, "u"), messageKey(2, "u")])
      dispose()
    })
  })

  test("no pending optimistic → append fresh (a queued drain or another client's send)", () => {
    createRoot((dispose) => {
      const s = createConversationSlice()
      s.resolveOptimisticUser(7, "queued message")
      expect(s.blocks()).toHaveLength(1)
      expect(keyOf(s.blocks()[0]!)).toBe(messageKey(7, "u"))
      dispose()
    })
  })
})

describe("reconcile — the resync merge preserves the live tail", () => {
  test("keeps live keyed blocks absent from the snapshot; drops keyless transient", () => {
    createRoot((dispose) => {
      const s = createConversationSlice()
      s.pushBlock({ kind: "user", text: "hi", key: messageKey(0, "u") })
      s.pushBlock({ kind: "assistant", text: "working", key: messageKey(1, "a") })
      s.pushBlock({ kind: "info", text: "attached to daemon" }) // transient
      s.pushBlock({ kind: "assistant", text: "in-flight tail", key: messageKey(3, "a") }) // not yet persisted
      // The DB snapshot only has the first two — the tail hasn't landed yet.
      s.reconcile([
        { kind: "user", text: "hi", key: messageKey(0, "u") },
        { kind: "assistant", text: "working", key: messageKey(1, "a") },
      ])
      // snapshot prefix + the surviving live tail; the transient info dropped.
      expect(s.blocks().map(keyOf)).toEqual([
        messageKey(0, "u"),
        messageKey(1, "a"),
        messageKey(3, "a"),
      ])
      dispose()
    })
  })
})

describe("cross-writer key equality — the contract the dedup rests on", () => {
  const history: ReadonlyArray<AgentMessage> = [
    { role: "user", content: "q" },
    { role: "assistant", content: [{ type: "text", text: "a" }] },
  ]

  test("projectHistory stamps the SAME key the live pump computes (messageKey)", () => {
    const proj = projectHistory(history, [], 0)
    const user = proj.blocks.find((b) => b.kind === "user")!
    const asst = proj.blocks.find((b) => b.kind === "assistant")!
    // The pump keys a `user_message{position:0}` as messageKey(0,"u") and an
    // `assistant_message{position:1}` as messageKey(1,"a",0) — the same helper.
    expect(keyOf(user)).toBe(messageKey(0, "u"))
    expect(keyOf(asst)).toBe(messageKey(1, "a", 0))
  })

  test("baseOffset makes keys absolute → handoff-safe (a narrowed window keeps abs keys)", () => {
    // The same two messages projected as a post-checkpoint window starting at
    // absolute position 4 (latestCheckpoint.messagePosition + 1 === 4).
    const windowed = projectHistory(history, [], 4)
    const user = windowed.blocks.find((b) => b.kind === "user")!
    const asst = windowed.blocks.find((b) => b.kind === "assistant")!
    expect(keyOf(user)).toBe(messageKey(4, "u"))
    expect(keyOf(asst)).toBe(messageKey(5, "a", 0))
  })
})
