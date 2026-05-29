import type { Tool } from "@effect/ai"
import { Effect } from "effect"
import type { AgentHooks } from "../entities/AgentHooks.js"
import type { AgentMessage, ConversationId } from "../entities/Conversation.js"
import { ConversationStore } from "../ports/ConversationStore.js"
import { SettingsStore } from "../ports/SettingsStore.js"
import { runAgentLoop } from "./agentLoop.js"
import type { AgentConfig } from "./agentConfig.js"

/**
 * Run the agent for one user prompt against a chosen config.
 *
 *   1. Load persisted history; append the new user message (persist now).
 *   2. Drive the loop with `messages = stored + user`. `@effect/ai`'s
 *      `LanguageModel` and the toolkit's handler Layer are taken from
 *      context (provided by the driver's composition root).
 *   3. Persist the new tail.
 *
 * (Provider-side context caching is a follow-up — it rode on the removed
 * `LlmCache` port and will return via `@effect/ai-google`'s `cachedContent`.)
 */
export const runAgent = <Tools extends Record<string, Tool.Any>, R>(
  config: AgentConfig<Tools>,
  conversationId: ConversationId,
  userPrompt: string,
  extraHooks?: AgentHooks<R>,
  workspaceDir?: string,
) =>
  Effect.gen(function* () {
    const store = yield* ConversationStore
    const settingsStore = yield* SettingsStore
    const settings = yield* settingsStore.get()

    yield* store.ensure(conversationId, workspaceDir)
    const stored = yield* store.list(conversationId)

    const userMsg: AgentMessage = { role: "user", content: userPrompt }
    yield* store.append(conversationId, userMsg)

    const result = yield* runAgentLoop({
      system: config.systemPrompt,
      messages: [...stored, userMsg],
      toolkit: config.toolkit,
      maxSteps: settings.maxSteps,
      ...(extraHooks !== undefined ? { hooks: extraHooks } : {}),
    })

    const newTail = result.messages.slice(stored.length + 1)
    for (const m of newTail) {
      yield* store.append(conversationId, m)
    }

    return result
  })
