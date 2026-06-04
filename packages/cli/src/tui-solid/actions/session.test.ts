import { test, expect } from "bun:test"
import type { AgentMessage, ConversationId } from "@efferent/core"
import { emptySidePane, emptyStats } from "../../tui/sidePane.js"
import { buildContextView } from "../../tui/contextView.js"
import { createTuiStore, type TuiStore } from "../state/store.js"
import { applyBuilt, applyContextRebuild, applyResume } from "./session.js"
import { replayBlocks } from "./replay.js"

const cid = (s: string): ConversationId => s as unknown as ConversationId

const user = (text: string): AgentMessage => ({ role: "user", content: text })
const assistant = (text: string): AgentMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
})
const toolCall = (id: string, name: string): AgentMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: id, toolName: name, input: { path: "a.ts" } }],
})
const toolResult = (id: string, name: string, isError = false): AgentMessage => ({
  role: "tool",
  content: [{ type: "tool-result", toolCallId: id, toolName: name, output: { content: "x" }, isError }],
})

const newStore = (): TuiStore =>
  createTuiStore({
    status: {
      modelId: "m",
      contextWindow: 1000,
      inputTokens: 0,
      cacheReadTokens: 0,
      cwd: "/work",
      storage: "sqlite",
    },
    conversationId: cid("00000000-0000-0000-0000-000000000000"),
    footer: "f",
    sidePane: { ...emptySidePane, stats: { ...emptyStats, contextWindow: 1000 } },
  })

test("replayBlocks turns a history into rail blocks, patching tool results in place", () => {
  const blocks = replayBlocks(
    [user("read it"), toolCall("t1", "read_file"), toolResult("t1", "read_file")],
    [],
  )
  expect(blocks.map((b) => b.kind)).toEqual(["user", "tool"])
  const tool = blocks.find((b) => b.kind === "tool")
  expect(tool).toMatchObject({ kind: "tool", id: "t1", state: "ok" })
  // every block is tagged with its source message position
  expect(blocks[0]).toMatchObject({ kind: "user", msgIndex: 0 })
})

test("replayBlocks marks an errored tool result", () => {
  const blocks = replayBlocks([toolCall("t1", "Bash"), toolResult("t1", "Bash", true)], [])
  expect(blocks.find((b) => b.kind === "tool")).toMatchObject({ state: "error" })
})

test("replayBlocks inserts a checkpoint block at the folded position", () => {
  const blocks = replayBlocks(
    [user("a"), assistant("b")],
    [{ id: "c", conversationId: cid("x"), messagePosition: 1, summary: "SUM", createdAt: 0 }],
  )
  expect(blocks.some((b) => b.kind === "checkpoint" && b.text === "SUM")).toBe(true)
})

test("applyResume swaps the conversation, replays it, and seeds the context viewer", () => {
  const store = newStore()
  store.pushBlock({ kind: "user", text: "stale" })
  const target = cid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
  const history = [user("hi"), assistant("yo"), user("again"), assistant("sure")]

  applyResume(store, target, history, [])

  expect(store.run.conversationId).toBe(target)
  // the stale block is gone; the replayed history + the "resumed" info line are present
  expect(store.blocks().some((b) => b.kind === "user" && b.text === "stale")).toBe(false)
  expect(store.blocks().some((b) => b.kind === "user" && b.text === "hi")).toBe(true)
  expect(store.blocks().at(-1)).toMatchObject({ kind: "info" })
  // context viewer is built and starts fully folded (a clean selectable list)
  expect(store.sidePane().context).toHaveLength(1)
  expect(store.sidePane().contextCollapsed.has("turn:0")).toBe(true)
  expect(store.sidePane().view).toBe("stack")
})

test("applyBuilt switches to the new session and focuses the input", () => {
  const store = newStore()
  const newId = cid("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
  const picked = [user("seed"), assistant("ok")]

  applyBuilt(store, newId, picked, 1, 0)

  expect(store.run.conversationId).toBe(newId)
  expect(store.focus()).toBe("input")
  expect(store.mode()).toBe("insert")
  expect(store.blocks().some((b) => b.kind === "user" && b.text === "seed")).toBe(true)
  const info = store.blocks().at(-1)
  expect(info).toMatchObject({ kind: "info" })
  expect((info as { text: string }).text).toContain("built new session")
  expect((info as { text: string }).text).toContain("1 turn")
})

test("applyContextRebuild refreshes segments and resets the cursor + selection", () => {
  const store = newStore()
  // pre-dirty the selection/cursor so we can see the reset
  store.setSidePane((s) => ({
    ...s,
    contextSelected: new Set([3]),
    contextCursor: 9,
  }))
  const segs = buildContextView([user("a"), assistant("b")], [])

  applyContextRebuild(store, segs)

  expect(store.sidePane().context).toBe(segs)
  expect(store.sidePane().contextSelected.size).toBe(0)
  expect(store.sidePane().contextCursor).toBe(0)
})
