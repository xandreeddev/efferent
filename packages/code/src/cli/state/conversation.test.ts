import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { AgentMessage } from "@xandreed/sdk-core"
import {
  ensureToolCallIds,
  responseToAgentMessages,
  responseToolCalls,
  responseToolResults,
} from "@xandreed/sdk-core"
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

describe("reconcile — tool/agents blocks are the projection's to own", () => {
  test("an unmatched live tool/agents block is DROPPED (no jump-to-end), the projection supplies it", () => {
    createRoot((dispose) => {
      const s = createConversationSlice()
      // A finished turn as the LIVE pump built it: a message, a tool pill, a
      // fan-out block. The live ids match what projectHistory now stamps.
      s.pushBlock({ kind: "user", text: "go", key: messageKey(0, "u") })
      s.pushBlock({ kind: "tool", id: "call_1", toolName: "grep(x)", state: "ok" })
      s.pushBlock({ kind: "agents", id: "ag:node_1", agents: [] })
      // A STALE live block under an ephemeral id the projection will never carry
      // (the old `ag<seq>`/`t<seq>` scheme) — the bug's raw material.
      s.pushBlock({ kind: "agents", id: "ag7", agents: [] })
      // The DB snapshot for this idle turn: message + the two real-id blocks.
      s.reconcile([
        { kind: "user", text: "go", key: messageKey(0, "u") },
        { kind: "tool", id: "call_1", toolName: "grep(x)", state: "ok" },
        { kind: "agents", id: "ag:node_1", agents: [] },
      ])
      // The matched tool/agents blocks appear once, at their projection slot; the
      // unmatched live `ag7` is gone (not appended to the end). No reorder, no dup.
      expect(s.blocks().map((b) => (b.kind === "tool" || b.kind === "agents" ? b.id : keyOf(b)))).toEqual([
        messageKey(0, "u"),
        "call_1",
        "ag:node_1",
      ])
      dispose()
    })
  })

  test("an unmatched live MESSAGE tail is still kept (streaming reply not dropped)", () => {
    createRoot((dispose) => {
      const s = createConversationSlice()
      s.pushBlock({ kind: "user", text: "go", key: messageKey(0, "u") })
      s.pushBlock({ kind: "tool", id: "t9", toolName: "ls()", state: "running" }) // stale live tool
      s.pushBlock({ kind: "assistant", text: "streaming…", key: messageKey(2, "a") }) // live tail
      s.reconcile([{ kind: "user", text: "go", key: messageKey(0, "u") }])
      // The live message tail survives; the unmatched live tool does not.
      expect(s.blocks().map(keyOf)).toEqual([messageKey(0, "u"), messageKey(2, "a")])
      dispose()
    })
  })
})

describe("cross-writer key equality — the contract the dedup rests on", () => {
  const history: ReadonlyArray<AgentMessage> = [
    { role: "user", content: "q" },
    { role: "assistant", content: [{ type: "text", text: "a" }] },
  ]

  test("projectHistory keys a tool pill by its tool-call id (matches the live pump)", () => {
    const withTool: ReadonlyArray<AgentMessage> = [
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call_42", toolName: "grep", input: { pattern: "x" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call_42", toolName: "grep", output: "no matches" }] },
    ]
    const proj = projectHistory(withTool, [], 0)
    const tool = proj.blocks.find((b) => b.kind === "tool")!
    // The live pump now stamps the rail pill `event.id` (the tool-call id), so
    // a resync upserts in place instead of appending a twin.
    expect(tool.kind === "tool" && tool.id).toBe("call_42")
  })

  test("projectHistory renders a run_agent spawn as NO rail block (the fleet is on the right)", () => {
    const withSpawn: ReadonlyArray<AgentMessage> = [
      { role: "user", content: "build it" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call_spawn", toolName: "run_agent", input: { folder: "src", name: "backend" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call_spawn", toolName: "run_agent", output: { nodeId: "node_abc", status: "running" } }] },
    ]
    const proj = projectHistory(withSpawn, [], 0)
    // The spawn surfaces only in the execution tree — no fan-out / tool block on the rail.
    expect(proj.blocks.some((b) => b.kind === "agents")).toBe(false)
    expect(proj.blocks.some((b) => b.kind === "tool")).toBe(false)
  })

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

describe("id-less tool calls — deterministic id keeps the rail pill stable on re-attach", () => {
  // The live pump's rail-pill id: it uses `event.id` when non-empty, else an
  // ephemeral per-process `t<seq>` (the bug's source). After the loop synthesizes
  // a deterministic id at the source, `event.id` is always non-empty, so this
  // mirrors what the pump stamps without needing the `t<seq>` branch.
  const livePillId = (e: { id: string; toolName: string }): string =>
    e.id.length > 0 ? e.id : "<UNSTABLE-t-seq>"

  test("the loop's synthesized id reaches the persisted message AND the live event, and projectHistory recomputes the SAME rail-pill id", () => {
    // A provider (Gemini) that returns a tool call WITHOUT an id. This is the
    // raw response content for ONE turn (turnIndex 1 in this run).
    const content = [
      { type: "tool-call", id: "", name: "grep", params: { pattern: "x" } },
      { type: "tool-result", id: "", name: "grep", result: "no matches" },
    ]

    // ── what the loop does, in order ──
    ensureToolCallIds(content, 1)

    // (a) the EVENTS the hooks emit (tool_call_start carries `event.id`)
    const liveId = livePillId({
      id: responseToolCalls(content)[0]!.id,
      toolName: responseToolCalls(content)[0]!.toolName,
    })
    // the matching result's id rides the tool_call_end event the same way
    const liveResultId = responseToolResults(content)[0]!.id

    // (b) the PERSISTED messages (this is what lands in the store)
    const tail = responseToAgentMessages(content)
    const persisted: ReadonlyArray<AgentMessage> = [
      { role: "user", content: "find x" },
      ...(tail as ReadonlyArray<AgentMessage>),
    ]

    // ── re-attach / idle resync: project the persisted messages ──
    const proj = projectHistory(persisted, [], 0)
    const projectedPill = proj.blocks.find((b) => b.kind === "tool")!

    // The synthesized id is one value end-to-end: event == projected pill ==
    // the result's id (so the call/result pairing is intact). No `t<seq>`, so
    // the re-projected pill upserts onto the live pill instead of jumping to the
    // end / duplicating.
    expect(liveId).toBe("1:grep:0")
    expect(liveResultId).toBe("1:grep:0")
    expect(projectedPill.kind === "tool" && projectedPill.id).toBe("1:grep:0")
    expect(projectedPill.kind === "tool" && projectedPill.id).toBe(liveId)
  })
})
