import { FiberRef } from "effect"
import type { ContextNodeId } from "../entities/AgentContext.js"
import type { CompressionPolicy } from "../entities/Compression.js"
import type { ConversationId } from "../entities/Conversation.js"
import type { ModelRole } from "../entities/Model.js"
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
  /** The **pinned model per role**, frozen by `runAgent` at the top-level turn —
   *  `{ general, code, fast } → "<provider>:<modelId>"`. The router resolves a
   *  fiber's call to `pinnedModels[role]`, so a mid-run `/model` or `:set
   *  codeModel` can NOT move the model out from under a running fleet (the
   *  "changing the default breaks a fleet" fix, now per-role and cache-safe — a
   *  stable selection keeps each provider's prompt-cache prefix warm). Inherited
   *  verbatim by every spawn in the subtree. Absent ⇒ the router falls back to
   *  the live settings / `ModelRegistry.current`. NOTE: this is the SESSION's
   *  choice, never a per-agent one — a running agent cannot pick its own model. */
  readonly pinnedModels?: Partial<Record<ModelRole, string>>
  /** Which model **role** the calls on this fiber resolve to (`Model.ModelRole`).
   *  The top-level run leaves it unset (⇒ `general`); each spawned sub-agent is
   *  seeded with the role it was spawned as (`general` for research/analysis,
   *  `code` for writing code). The router reads this to resolve the role's model
   *  — it is the ONLY thing that decides a fiber's model, and nothing the model
   *  emits can change it. */
  readonly modelRole?: ModelRole
  /** The human's original request for this run — the **mission**. Seeded by
   *  `runAgent` and inherited by every spawn, so each sub-agent can be reminded
   *  of the overall goal even when its `task` brief is terse (the structural
   *  backstop against context loss on spawn). A short, stable line ⇒ cache-safe. */
  readonly mission?: string
}

export const initialRunContext: RunContext = {
  rootConversationId: null,
  parentNodeId: null,
  depth: 0,
  tokenPool: null,
}

export const RunContextRef: FiberRef.FiberRef<RunContext> =
  FiberRef.unsafeMake<RunContext>(initialRunContext)
