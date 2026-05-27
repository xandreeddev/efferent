import { Effect } from "effect"
import type { AgentHooks } from "../entities/AgentHooks.js"
import type { AgentMessage, AgentResult, ConversationId } from "../entities/Conversation.js"
import { ConversationStore } from "../ports/ConversationStore.js"
import { Llm, type LlmCacheHint } from "../ports/Llm.js"
import { LlmCache } from "../ports/LlmCache.js"

import { runAgentLoop } from "./agentLoop.js"
import type { AgentConfig } from "./notesAgentConfig.js"

/**
 * In-process per-(conversation, config) cache hints. Each `runAgent` call:
 *  - reads the hint for this conversation+config (if any) and threads it
 *    through the loop so every `runTurn` references the same cache.
 *  - after the loop, asks the adapter for a fresh snapshot covering
 *    the full conversation through this turn. If we got a hint, store it
 *    — the next `runAgent` for the same conversation+config will reference
 *    a bigger cache.
 *
 * Keyed by `${conversationId}::${config.key}` so notes and coder sessions
 * sharing a conversation id don't poison each other's caches.
 *
 * In-memory: dies on process restart. Cache TTL is 1h so a long-lived
 * hint would 404 anyway; treating the map as ephemeral is fine.
 */
const cacheHintsByKey = new Map<string, LlmCacheHint>()

const cacheKey = (conversationId: ConversationId, configKey: string): string =>
  `${conversationId}::${configKey}`

/**
 * Run the agent for one user prompt against a chosen config.
 *
 *   1. Load persisted history.
 *   2. Append the new user message (persist immediately for audit on crash).
 *   3. Run the loop with `messages = stored + user`. A `cacheHint` (if
 *      available) is threaded through so every turn sees the same
 *      provider-side cache for the prior conversation.
 *   4. Persist the new tail.
 *   5. Snapshot the full final buffer into a fresh cache, store the hint
 *      for the next call. Best-effort; failures don't affect correctness.
 */
export const runAgent = <R>(
  config: AgentConfig<R>,
  conversationId: ConversationId,
  userPrompt: string,
  extraHooks?: AgentHooks<R | ConversationStore | Llm | LlmCache>,
) =>
  Effect.gen(function* () {
    const store = yield* ConversationStore
    const cache = yield* LlmCache

    yield* store.ensure(conversationId)

    const stored = yield* store.list(conversationId)

    const userMsg: AgentMessage = {
      role: "user",
      content: userPrompt,
    }
    yield* store.append(conversationId, userMsg)

    const key = cacheKey(conversationId, config.key)
    const cacheHint = cacheHintsByKey.get(key)
    const result: AgentResult = yield* runAgentLoop({
      system: config.systemPrompt,
      messages: [...stored, userMsg],
      tools: config.tools,
      ...(extraHooks !== undefined ? { hooks: extraHooks } : {}),
      ...(cacheHint !== undefined ? { cacheHint } : {}),
    })

    // Persist new tail.
    const newTail = result.messages.slice(stored.length + 1)
    for (const m of newTail) {
      yield* store.append(conversationId, m)
    }

    // Snapshot the full buffer for the NEXT runAgent in this conversation.
    // Best-effort: failures (e.g. content below the model's minimum) leave
    // the prior hint in place.
    const newHint = yield* cache.snapshot({
      system: config.systemPrompt,
      messages: result.messages,
      tools: config.tools,
    })
    if (newHint !== undefined) {
      cacheHintsByKey.set(key, newHint)
    }

    return result
  })
