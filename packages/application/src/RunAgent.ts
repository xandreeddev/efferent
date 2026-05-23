import { Effect } from "effect"
import {
  type AgentResult,
  type ConversationId,
  type ConversationMessage,
  ConversationStore,
  Llm,
} from "@agent/core"

import { agentSystemPrompt } from "./_prompts/agent.js"
import { buildCaptureTools } from "./_tools/captureTools.js"

export const runAgent = (
  conversationId: ConversationId,
  userPrompt: string,
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

    const tools = buildCaptureTools()
    const result: AgentResult = yield* llm.runAgent({
      system: agentSystemPrompt,
      messages: history,
      tools,
    })

    yield* store.append(conversationId, {
      role: "assistant",
      content: result.finalText,
      toolCalls: result.toolCalls,
    })
    for (const tr of result.toolResults) {
      yield* store.append(conversationId, {
        role: "tool",
        toolName: tr.toolName,
        result: tr.result,
      })
    }

    return result
  })
