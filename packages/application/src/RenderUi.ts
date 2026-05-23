import { Effect, Stream } from "effect"
import { type AgentResult, Llm } from "@agent/core"
import { renderUiPrompt } from "./_prompts/render-ui.js"

const summariseToolCalls = (
  result: AgentResult,
): string => {
  if (result.toolCalls.length === 0) return "(no tools called)"
  return result.toolCalls
    .map((tc) => `- ${tc.toolName}(${JSON.stringify(tc.args)})`)
    .join("\n")
}

/**
 * Second-pass renderer: takes the agent's final answer and produces one
 * HTML fragment matching the base template vocabulary. Streams chunks.
 */
export const renderUi = (userPrompt: string, agentResult: AgentResult) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const llm = yield* Llm
      const prompt =
        `User prompt: ${userPrompt.trim()}\n\n` +
        `Agent's final answer (markdown):\n${agentResult.finalText}\n\n` +
        `Tools the agent invoked:\n${summariseToolCalls(agentResult)}`
      return llm.streamGenerate({
        system: renderUiPrompt,
        prompt,
      })
    }),
  )
