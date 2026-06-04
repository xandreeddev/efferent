import { test, expect } from "bun:test"
import type { ConversationId } from "@efferent/core"
import { emptySidePane, emptyStats } from "../presentation/sidePane.js"
import { onToolStart } from "../presentation/executionTree.js"
import { createTuiStore, type TuiContext, type TuiStore } from "../state/store.js"
import { runCommand } from "./runCommand.js"

const cid = "00000000-0000-0000-0000-000000000000" as unknown as ConversationId

const newStore = (): TuiStore =>
  createTuiStore({
    status: {
      modelId: "m",
      cwd: "/work/space",
      storage: "sqlite",
    },
    conversationId: cid,
    footer: "f",
    sidePane: { ...emptySidePane, stats: { ...emptyStats, contextWindow: 1000 } },
  })

const ctxOf = (store: TuiStore, onExit: () => void = () => {}): TuiContext => ({
  store,
  run: () => Promise.resolve(undefined as never),
  submit: () => {},
  interrupt: () => {},
  exit: onExit,
  copySelection: () => false,
})

test(":clear empties the conversation", () => {
  const store = newStore()
  store.pushBlock({ kind: "user", text: "hi" })
  store.pushBlock({ kind: "assistant", text: "yo" })
  expect(store.blocks()).toHaveLength(2)
  runCommand(ctxOf(store), ":clear")
  expect(store.blocks()).toHaveLength(0)
})

test(":help pushes info lines", () => {
  const store = newStore()
  runCommand(ctxOf(store), ":help")
  expect(store.blocks().length).toBeGreaterThan(0)
  expect(store.blocks().every((b) => b.kind === "info")).toBe(true)
})

test(":cwd echoes the workspace path", () => {
  const store = newStore()
  runCommand(ctxOf(store), ":cwd")
  const last = store.blocks().at(-1)
  expect(last).toMatchObject({ kind: "info", text: "/work/space" })
})

test(":exit / :quit invoke ctx.exit", () => {
  let exited = 0
  const store = newStore()
  runCommand(ctxOf(store, () => exited++), ":exit")
  runCommand(ctxOf(store, () => exited++), ":quit")
  expect(exited).toBe(2)
})

test(":reset starts a fresh conversation and clears tree + scrollback", () => {
  const store = newStore()
  store.pushBlock({ kind: "user", text: "old" })
  store.setProjection((p) => ({ ...p, tree: onToolStart(p.tree, "read x", 0).tree }))
  const before = store.run.getConversationId()
  runCommand(ctxOf(store), ":reset")
  expect(store.run.getConversationId()).not.toBe(before)
  expect(store.sidePane().tree.roots).toHaveLength(0)
  // scrollback was cleared, then the "new conversation" info line pushed
  expect(store.blocks()).toHaveLength(1)
  expect(store.blocks()[0]).toMatchObject({ kind: "info" })
})

test("an unrecognised command reports back instead of failing silently", () => {
  const store = newStore()
  runCommand(ctxOf(store), ":nope")
  expect(store.blocks().at(-1)).toMatchObject({ kind: "info" })
  expect((store.blocks().at(-1) as { text: string }).text).toContain("unknown command")
})

test("a unique prefix resolves (`:cl` → :clear)", () => {
  const store = newStore()
  store.pushBlock({ kind: "user", text: "x" })
  runCommand(ctxOf(store), ":cl")
  expect(store.blocks()).toHaveLength(0) // :clear ran
})
