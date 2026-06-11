import { FiberRef } from "effect"
import type { ContextNodeId } from "../entities/AgentContext.js"
import type { ConversationId } from "../entities/Conversation.js"
import type { TokenPool } from "./tokenBudget.js"

/**
 * Ambient identity for the running agent, threaded via a `FiberRef` so the
 * generic `run_agent` tool can tag a spawned context node with its root
 * conversation, parent node, and depth — without those values being baked into
 * the (composition-root-built) handler layer. `runAgent` seeds it for the
 * top-level run; each spawn re-seeds it (parentNodeId = the spawning node,
 * depth + 1) for the agent it runs, so a nested spawn reads its true parent.
 *
 * `tokenPool` rides along the same way: one shared spend pool per top-level
 * turn, drawn from by every sub-agent in the subtree (see `tokenBudget.ts`).
 * It is the SAME `Ref` at every depth — re-seeding copies the reference, so a
 * grandchild's spend is visible to the root's gate.
 */
export interface RunContext {
  readonly rootConversationId: ConversationId | null
  readonly parentNodeId: ContextNodeId | null
  readonly depth: number
  readonly tokenPool: TokenPool
  /** Per-sub-agent step cap (`Settings.subAgentMaxSteps`), threaded live per
   *  run like the pool so `:set` applies on the next turn — absent → the
   *  built-in default (`DEFAULT_SUB_AGENT_MAX_STEPS`). */
  readonly subAgentMaxSteps?: number
  /** Headroom budget (chars) per tool-result string (`Settings.toolResultMaxTokens`
   *  × 4), threaded so sub-agent loops compress like the root. Absent → the
   *  built-in default; 0 disables. */
  readonly toolResultMaxChars?: number
}

export const initialRunContext: RunContext = {
  rootConversationId: null,
  parentNodeId: null,
  depth: 0,
  tokenPool: null,
}

export const RunContextRef: FiberRef.FiberRef<RunContext> =
  FiberRef.unsafeMake<RunContext>(initialRunContext)
