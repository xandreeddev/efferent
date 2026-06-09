import { FiberRef } from "effect"
import type { ContextNodeId } from "../entities/AgentContext.js"
import type { ConversationId } from "../entities/Conversation.js"

/**
 * Ambient identity for the running agent, threaded via a `FiberRef` so the
 * generic `run_agent` tool can tag a spawned context node with its root
 * conversation, parent node, and depth — without those values being baked into
 * the (composition-root-built) handler layer. `runAgent` seeds it for the
 * top-level run; each spawn re-seeds it (parentNodeId = the spawning node,
 * depth + 1) for the agent it runs, so a nested spawn reads its true parent.
 */
export interface RunContext {
  readonly rootConversationId: ConversationId | null
  readonly parentNodeId: ContextNodeId | null
  readonly depth: number
}

export const initialRunContext: RunContext = {
  rootConversationId: null,
  parentNodeId: null,
  depth: 0,
}

export const RunContextRef: FiberRef.FiberRef<RunContext> =
  FiberRef.unsafeMake<RunContext>(initialRunContext)
