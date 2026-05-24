import { Effect } from "effect"
import {
  type AgentHooks,
  type AgentResult,
  type CaptureStore,
  type ConversationId,
  type ConversationMessage,
  ConversationStore,
  Llm,
} from "@agent/core"

import { agentSystemPrompt } from "./_prompts/agent.js"
import { buildCaptureTools } from "./_tools/captureTools.js"

type AgentR = CaptureStore | Llm | ConversationStore

/**
 * Merge two hook bundles so both handlers fire per event. For decision-
 * style hooks, `extra` runs first and can short-circuit: if it blocks, the
 * built-in handler doesn't see the call. For boolean-style hooks (stop),
 * the OR of both wins. For transform-context, they compose left-to-right.
 */
const mergeHooks = <R>(
  base: AgentHooks<R>,
  extra: AgentHooks<R> | undefined,
): AgentHooks<R> => {
  if (!extra) return base
  return {
    onTurnStart: (e) =>
      Effect.gen(function* () {
        if (extra.onTurnStart) yield* extra.onTurnStart(e)
        if (base.onTurnStart) yield* base.onTurnStart(e)
      }),
    onAssistantMessage: (e) =>
      Effect.gen(function* () {
        if (extra.onAssistantMessage) yield* extra.onAssistantMessage(e)
        if (base.onAssistantMessage) yield* base.onAssistantMessage(e)
      }),
    onBeforeToolCall: (e) =>
      Effect.gen(function* () {
        if (extra.onBeforeToolCall) {
          const d = yield* extra.onBeforeToolCall(e)
          if (d.action === "block") return d
        }
        if (base.onBeforeToolCall) return yield* base.onBeforeToolCall(e)
        return { action: "continue" } as const
      }),
    onAfterToolCall: (e) =>
      Effect.gen(function* () {
        if (extra.onAfterToolCall) yield* extra.onAfterToolCall(e)
        if (base.onAfterToolCall) yield* base.onAfterToolCall(e)
      }),
    onTransformContext: (msgs) =>
      Effect.gen(function* () {
        let out = msgs
        if (extra.onTransformContext) out = yield* extra.onTransformContext(out)
        if (base.onTransformContext) out = yield* base.onTransformContext(out)
        return out
      }),
    onShouldStopAfterTurn: (e) =>
      Effect.gen(function* () {
        const a = extra.onShouldStopAfterTurn
          ? yield* extra.onShouldStopAfterTurn(e)
          : false
        if (a) return true
        return base.onShouldStopAfterTurn
          ? yield* base.onShouldStopAfterTurn(e)
          : false
      }),
    onAgentEnd: (e) =>
      Effect.gen(function* () {
        if (extra.onAgentEnd) yield* extra.onAgentEnd(e)
        if (base.onAgentEnd) yield* base.onAgentEnd(e)
      }),
  }
}

export const runAgent = (
  conversationId: ConversationId,
  userPrompt: string,
  extraHooks?: AgentHooks<AgentR>,
) =>
  Effect.gen(function* () {
    const store = yield* ConversationStore
    const llm = yield* Llm

    const userMsg: ConversationMessage = {
      role: "user",
      content: userPrompt,
    }
    yield* store.append(conversationId, userMsg)
    const history = yield* store.list(conversationId)

    // Built-in hook: persist each tool result to ConversationStore as it
    // happens, instead of batching at the end. This means a crash mid-loop
    // still leaves a faithful audit trail in Postgres. Persistence errors
    // are swallowed — they shouldn't crash the agent loop; at worst we
    // lose an audit row.
    const persistenceHooks: AgentHooks<AgentR> = {
      onAfterToolCall: (e) =>
        store
          .append(conversationId, {
            role: "tool",
            toolName: e.toolName,
            result: e.result,
          })
          .pipe(
            Effect.catchAll((err) =>
              Effect.logError("Failed to persist tool result", err),
            ),
          ),
    }

    const tools = buildCaptureTools()
    const result: AgentResult = yield* llm.runAgent({
      system: agentSystemPrompt,
      messages: history,
      tools,
      hooks: mergeHooks(persistenceHooks, extraHooks),
    })

    yield* store.append(conversationId, {
      role: "assistant",
      content: result.finalText,
      toolCalls: result.toolCalls,
    })

    return result
  })
