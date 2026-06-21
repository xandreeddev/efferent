import { test, expect } from "bun:test"
import type { ConversationId } from "@xandreed/sdk-core"
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
  resolveApproval: () => {},
  roles: [],
  tools: [],
  spawnAgent: () => {},
  stopAgent: () => {},
  listFleet: () => [],
  liveAgents: () => [],
  importAgents: () => {},
  importTools: () => {},
  getDirective: () => undefined,
  setDirective: () => {},
})

test(":clear starts a new conversation and clears scrollback", () => {
  const store = newStore()
  store.pushBlock({ kind: "user", text: "hi" })
  store.pushBlock({ kind: "assistant", text: "yo" })
  expect(store.blocks()).toHaveLength(2)
  const before = store.run.getConversationId()
  runCommand(ctxOf(store), ":clear")
  expect(store.run.getConversationId()).not.toBe(before)
  expect(store.blocks()).toHaveLength(1)
  expect(store.blocks()[0]).toMatchObject({ kind: "info", text: expect.stringMatching(/^new conversation: /) })
})

test(":help is gone — it toasts as unknown instead of dumping info lines", () => {
  const store = newStore()
  runCommand(ctxOf(store), ":help")
  expect(store.blocks()).toHaveLength(0) // no HELP dump; the keybind box owns keys
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

test(":clear also resets the side pane tree and stats", () => {
  const store = newStore()
  store.pushBlock({ kind: "user", text: "old" })
  store.setProjection((p) => ({ ...p, tree: onToolStart(p.tree, "read x", 0).tree }))
  const before = store.run.getConversationId()
  runCommand(ctxOf(store), ":clear")
  expect(store.run.getConversationId()).not.toBe(before)
  expect(store.sidePane().tree.roots).toHaveLength(0)
  expect(store.blocks()).toHaveLength(1)
  expect(store.blocks()[0]).toMatchObject({ kind: "info", text: expect.stringMatching(/^new conversation: /) })
})

test("an unrecognised command reports back instead of failing silently", () => {
  const store = newStore()
  runCommand(ctxOf(store), ":nope")
  // feedback is a toast (status note), not a permanent rail block
  expect(store.note()).toContain("unknown command")
  expect(store.blocks().some((b) => b.kind === "info")).toBe(false)
})

test("a unique prefix resolves (`:cl` → :clear)", () => {
  const store = newStore()
  store.pushBlock({ kind: "user", text: "x" })
  runCommand(ctxOf(store), ":cl")
  expect(store.blocks()).toHaveLength(1) // :clear ran and pushed the info line
})

test("bare `:set` opens the settings menu (no usage error)", () => {
  const store = newStore()
  runCommand(ctxOf(store), ":set")
  // The settings overlay is opened via ctx.run (a no-op stub here), so no error
  // block is pushed — the old usage error is gone for the bare form.
  expect(store.blocks().some((b) => b.kind === "error")).toBe(false)
})

test("`:set <key>` with no value still hints the direct form", () => {
  const store = newStore()
  runCommand(ctxOf(store), ":set maxSteps")
  expect(store.blocks().at(-1)).toMatchObject({ kind: "error", text: expect.stringContaining("Usage: :set") })
})
