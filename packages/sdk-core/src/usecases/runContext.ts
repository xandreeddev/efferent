import { FiberRef } from "effect"
import type { ContextNodeId } from "../entities/AgentContext.js"
import type { CompressionPolicy } from "../entities/Compression.js"
import type { ConversationId } from "../entities/Conversation.js"
import type { Prompt } from "../entities/Prompt.js"
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
  /** The prompt identity (name/version/variant) this run uses, surfaced on
   *  every `llm.generate` span so Grafana shows which prompt produced the call. */
  readonly prompt?: Prompt
  /** Per-sub-agent step cap (`Settings.subAgentMaxSteps`), threaded live per
   *  run like the pool so `:set` applies on the next turn — absent → the
   *  built-in default (`DEFAULT_SUB_AGENT_MAX_STEPS`). */
  readonly subAgentMaxSteps?: number
  /** Compaction budget (chars) per tool-result string (`Settings.toolResultMaxTokens`
   *  × 4), threaded so sub-agent loops compress like the root. Absent → the
   *  built-in default; 0 disables. */
  readonly toolResultMaxChars?: number
  /** The agent's compression policy, threaded so the whole sub-agent subtree
   *  inherits it (the loop reads this when no `input.compression` override is
   *  given). Absent → `Compaction.default()`. */
  readonly compression?: CompressionPolicy
  /** Per-run main-model override as `"<provider>:<modelId>"` — set by an agent
   *  ROLE (`run_agent({ agent })`) whose definition pins a model. The router
   *  prefers this over the global `ModelRegistry.current` for main-tier calls on
   *  this fiber; helper tiers (fast/web-search) are unaffected. Absent ⇒ the
   *  session's main model. NOT inherited by nested generic spawns — only set
   *  when the spawned child's own role pins a model. */
  readonly modelOverride?: string
}

export const initialRunContext: RunContext = {
  rootConversationId: null,
  parentNodeId: null,
  depth: 0,
  tokenPool: null,
}

export const RunContextRef: FiberRef.FiberRef<RunContext> =
  FiberRef.unsafeMake<RunContext>(initialRunContext)
