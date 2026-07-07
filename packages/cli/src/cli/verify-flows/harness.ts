import type { ConversationId } from "@xandreed/sdk-core"
import { emptySidePane, emptyStats } from "../presentation/sidePane.js"
import { createTuiStore, type TuiContext, type TuiStore } from "../state/store.js"

/**
 * Shared testRender harness for the verify-flow UI tests — the same `newStore` +
 * no-op `fakeCtx` pattern app.test.ts uses, so a flow is driven by setting the
 * pure presentation state on the store and asserting the rendered frame. These
 * tests are Tier A of `efferent verify` AND ordinary CI coverage (plain bun test).
 */

export const cid = "00000000-0000-0000-0000-000000000000" as unknown as ConversationId

export const newStore = (): TuiStore =>
  createTuiStore({
    status: { modelId: "test-model", cwd: "/tmp/ws", storage: "sqlite" },
    conversationId: cid,
    footer: "logs: …",
    sidePane: { ...emptySidePane, stats: { ...emptyStats, contextWindow: 1_000_000 } },
  })

export const fakeCtx = (store: TuiStore): TuiContext => ({
  store,
  variant: "master",
  run: () => Promise.resolve(undefined as never),
  submit: () => {},
  interrupt: () => {},
  newConversation: () => {},
  clearQueue: () => {},
  exit: () => {},
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
})
