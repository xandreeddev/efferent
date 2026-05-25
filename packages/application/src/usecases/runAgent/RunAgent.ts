import { Effect } from "effect"
import {
  type AgentHooks,
  type AgentMessage,
  type AgentResult,
  type CaptureStore,
  type ConversationId,
  ConversationStore,
  Llm,
  type LlmCacheHint,
} from "@agent/core"

import { runAgentLoop } from "./agentLoop.js"
import { agentSystemPrompt } from "../../prompts/agent.js"
import { buildCaptureTools } from "./captureTools.js"

type AgentR = CaptureStore | Llm | ConversationStore

/**
 * In-process per-conversation cache hints. Each `runAgent` call:
 *  - reads the hint for this conversation (if any) and threads it
 *    through the loop so every `runTurn` references the same cache.
 *  - after the loop, asks the adapter for a fresh snapshot covering
 *    the full conversation through this turn. If we got a hint, store
 *    it — the next `runAgent` for this conversation will reference a
 *    bigger cache.
 *
 * In-memory: dies on process restart. Cache TTL is 1h so a long-lived
 * hint would 404 anyway; treating the map as ephemeral is fine. A
 * Postgres-backed version is a future slice when conversations need
 * to survive deploys.
 */
const cacheHintsByConversation = new Map<string, LlmCacheHint>()

/**
 * Run the agent for one user prompt.
 *
 *   1. Load persisted history.
 *   2. Append the new user message (persist immediately for audit on
 *      crash).
 *   3. Run the loop with `messages = stored + user`. Each iteration
 *      sends the full buffer to `Llm.runTurn`, appends the response.
 *      A `cacheHint` (if available) is threaded through so every turn
 *      sees the same provider-side cache for the prior conversation.
 *   4. Persist the new tail.
 *   5. Snapshot the full final buffer into a fresh cache, store the
 *      hint for the next call. Best-effort; failures don't affect
 *      correctness.
 */
export const runAgent = (
  conversationId: ConversationId,
  userPrompt: string,
  extraHooks?: AgentHooks<AgentR>,
) =>
  Effect.gen(function* () {
    const store = yield* ConversationStore
    const llm = yield* Llm

    yield* store.ensure(conversationId)

    const stored = yield* store.list(conversationId)

    const userMsg: AgentMessage = {
      role: "user",
      content: userPrompt,
    }
    yield* store.append(conversationId, userMsg)

    const tools = buildCaptureTools()
    const cacheHint = cacheHintsByConversation.get(conversationId)
    const result: AgentResult = yield* runAgentLoop({
      system: agentSystemPrompt,
      messages: [...stored, userMsg],
      tools,
      ...(extraHooks !== undefined ? { hooks: extraHooks } : {}),
      ...(cacheHint !== undefined ? { cacheHint } : {}),
    })

    // Persist new tail.
    const newTail = result.messages.slice(stored.length + 1)
    for (const m of newTail) {
      yield* store.append(conversationId, m)
    }

    // Snapshot the full buffer for the NEXT runAgent in this
    // conversation. Best-effort: failures (e.g. content below the
    // model's minimum) leave the prior hint in place.
    const newHint = yield* llm.snapshot({
      system: agentSystemPrompt,
      messages: result.messages,
      tools,
    })
    if (newHint !== undefined) {
      cacheHintsByConversation.set(conversationId, newHint)
    }

    return result
  })
