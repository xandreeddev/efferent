import type { AgentTool } from "../entities/AgentTool.js"
import type { CaptureStore } from "../ports/CaptureStore.js"
import type { LlmFast } from "../ports/LlmFast.js"
import { buildCaptureTools } from "./captureTools.js"
import { notesSystemPrompt } from "../prompts/notes.js"

export interface AgentConfig<R> {
  /** Stable identifier for cache-key isolation across configs in the same conversation. */
  readonly key: string
  readonly systemPrompt: string
  readonly tools: ReadonlyArray<AgentTool<any, any, R>>
}

export const notesAgentConfig: AgentConfig<CaptureStore | LlmFast> = {
  key: "notes",
  systemPrompt: notesSystemPrompt,
  tools: buildCaptureTools(),
}
