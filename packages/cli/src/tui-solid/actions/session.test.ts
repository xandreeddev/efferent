import { test, expect } from "bun:test"
import type { AgentMessage, ConversationId } from "@efferent/core"
import { emptySidePane, emptyStats } from "../presentation/sidePane.js"
import { buildContextView } from "../presentation/contextView.js"
import { createTuiStore, type TuiStore } from "../state/store.js"
import {
  applyBuilt,
  applyContextRebuild,
  applyResume,
  conversationPickerOptions,
} from "./session.js"
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

test("replayBlocks rebuilds run_agent bursts as an agents block carrying the returned summary", () => {
  const spawn = (id: string, folder: string, seedMode?: string): AgentMessage => ({
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: id,
        toolName: "run_agent",
        input: { folder, task: "audit it", ...(seedMode !== undefined ? { seedMode } : {}) },
      },
    ],
  })
  const spawnResult = (id: string, summary: string): AgentMessage => ({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: id,
        toolName: "run_agent",
        output: { summary, filesChanged: [], nodeId: "node-1" },
        isError: false,
      },
    ],
  })
  const blocks = replayBlocks(
    [user("go"), spawn("c1", "/w/pkg/tui", "handoff"), spawnResult("c1", "All layers respected.")],
    [],
  )
  // No bare `run_agent ⎿ done` pill — the spawn renders as the agents container.
  expect(blocks.some((b) => b.kind === "tool")).toBe(false)
  const ag = blocks.find((b) => b.kind === "agents")
  expect(ag).toBeDefined()
  if (ag?.kind !== "agents") throw new Error("expected agents block")
  const row = ag.agents[0]!
  expect(row.name).toBe("tui · handoff")
  expect(row.status).toBe("ok")
  expect(row.summary).toBe("All layers respected.")
  expect(row.nodeId).toBe("node-1") // re-keyed from the call id by the result
})

test("replayBlocks marks a failed run_agent row and surfaces the failure", () => {
  const blocks = replayBlocks(
    [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "c1", toolName: "run_agent", input: { folder: "/w/x", task: "t" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "run_agent",
            output: { error: "MaxDepthReached", message: "too deep" },
            isError: true,
          },
        ],
      },
    ],
    [],
  )
  const ag = blocks.find((b) => b.kind === "agents")
  if (ag?.kind !== "agents") throw new Error("expected agents block")
  expect(ag.agents[0]!.status).toBe("error")
  expect(blocks.some((b) => b.kind === "error" && b.text === "too deep")).toBe(true)
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

  expect(store.run.getConversationId()).toBe(target)
  // the stale block is gone; the replayed history + the "resumed" info line are present
  expect(store.blocks().some((b) => b.kind === "user" && b.text === "stale")).toBe(false)
  expect(store.blocks().some((b) => b.kind === "user" && b.text === "hi")).toBe(true)
  expect(store.blocks().at(-1)).toMatchObject({ kind: "info" })
  // context viewer is built and starts fully folded (a clean selectable list)
  expect(store.sidePane().context).toHaveLength(1)
  expect(store.sidePane().contextCollapsed.has("turn:0")).toBe(true)
  expect(store.sidePane().view).toBe("stack")
})

test("applyResume rebuilds the Activity tree from the loaded messages (folded runs)", () => {
  const store = newStore()
  const target = cid("cccccccc-cccc-cccc-cccc-cccccccccccc")
  const history = [
    user("first task"),
    toolCall("t1", "read_file"),
    toolResult("t1", "read_file"),
    user("second task"),
    assistant("done"),
  ]

  applyResume(store, target, history, [])

  const roots = store.projection().tree.roots
  expect(roots.map((r) => r.kind)).toEqual(["run", "run"])
  expect(roots.map((r) => r.label)).toEqual(["first task", "second task"])
  // every rebuilt run lands folded; the workspace section folds survive the union
  for (const r of roots) expect(store.nav().stackCollapsed.has(`node:${r.id}`)).toBe(true)
  expect(store.nav().stackCollapsed.has("files")).toBe(true)
})

test("applyBuilt rebuilds the Activity tree for the picked messages", () => {
  const store = newStore()
  applyBuilt(store, cid("dddddddd-dddd-dddd-dddd-dddddddddddd"), [user("seed"), assistant("ok")], 1, 0)
  expect(store.projection().tree.roots.map((r) => r.kind)).toEqual(["run"])
})

test("applyBuilt switches to the new session and focuses the input", () => {
  const store = newStore()
  const newId = cid("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
  const picked = [user("seed"), assistant("ok")]

  applyBuilt(store, newId, picked, 1, 0)

  expect(store.run.getConversationId()).toBe(newId)
  expect(store.focus()).toBe("input")
  expect(store.mode()).toBe("insert")
  expect(store.blocks().some((b) => b.kind === "user" && b.text === "seed")).toBe(true)
  const info = store.blocks().at(-1)
  expect(info).toMatchObject({ kind: "info" })
  expect((info as { text: string }).text).toContain("built new session")
  expect((info as { text: string }).text).toContain("1 turn")
})

test("conversationPickerOptions leads with 'start new', then a row per conversation", () => {
  const opts = conversationPickerOptions([
    { id: cid("11111111-1111-1111-1111-111111111111"), createdAt: 0, firstPrompt: "  fix   the\nparser  " },
    { id: cid("22222222-2222-2222-2222-222222222222"), createdAt: 0 },
  ])
  // leading "start new" row carries the null sentinel
  expect(opts[0]).toMatchObject({ value: null })
  expect(opts[0]!.label).toContain("Start a new conversation")
  expect(opts).toHaveLength(3)
  // first conversation: id as value, whitespace-collapsed prompt preview
  expect(opts[1]!.value).toBe(cid("11111111-1111-1111-1111-111111111111"))
  expect(opts[1]!.label).toContain("fix the parser")
  // missing prompt → "(empty)" fallback
  expect(opts[2]!.label).toContain("(empty)")
})

test("conversationPickerOptions caps a long prompt preview (modal truncates to fit)", () => {
  const long = "x".repeat(200)
  const [, row] = conversationPickerOptions([
    { id: cid("33333333-3333-3333-3333-333333333333"), createdAt: 0, firstPrompt: long },
  ])
  const preview = row!.label.split(" · ")[1] ?? ""
  expect(preview.length).toBe(80)
})

test("applyContextRebuild refreshes segments and resets the cursor + selection", () => {
  const store = newStore()
  // pre-dirty the selection/cursor so we can see the reset
  store.setNav((n) => ({
    ...n,
    contextSelected: new Set([3]),
    contextCursor: 9,
  }))
  const segs = buildContextView([user("a"), assistant("b")], [])

  applyContextRebuild(store, segs)

  expect(store.sidePane().context).toBe(segs)
  expect(store.sidePane().contextSelected.size).toBe(0)
  expect(store.sidePane().contextCursor).toBe(0)
})
