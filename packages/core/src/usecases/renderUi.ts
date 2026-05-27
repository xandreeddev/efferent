import { Effect, Stream } from "effect"
import type { AgentMessage, AgentResult } from "../entities/Conversation.js"
import { LlmFast } from "../ports/LlmFast.js"
import { renderUiPrompt } from "../prompts/renderUi.js"

const summariseToolCalls = (messages: ReadonlyArray<AgentMessage>): string => {
  const calls: { toolName: string; input: unknown }[] = []
  for (const m of messages) {
    if (m.role !== "assistant") continue
    for (const part of m.content) {
      if (part.type === "tool-call") {
        calls.push({ toolName: part.toolName, input: part.input })
      }
    }
  }
  if (calls.length === 0) return "(no tools called)"
  return calls
    .map((c) => `- ${c.toolName}(${JSON.stringify(c.input)})`)
    .join("\n")
}

/**
 * Second-pass renderer: takes the agent's final answer and produces one
 * HTML fragment matching the base template vocabulary. Streams chunks.
 */
export const renderUi = (userPrompt: string, agentResult: AgentResult) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const llm = yield* LlmFast
      const prompt =
        `User prompt: ${userPrompt.trim()}\n\n` +
        `Agent's final answer (markdown):\n${agentResult.finalText}\n\n` +
        `Tools the agent invoked:\n${summariseToolCalls(agentResult.messages)}`
      return llm.streamGenerate({
        system: renderUiPrompt,
        prompt,
      })
    }),
  )
