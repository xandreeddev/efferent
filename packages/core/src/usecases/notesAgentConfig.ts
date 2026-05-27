import type { AgentTool } from "../entities/AgentTool.js"
import type { CaptureStore } from "../ports/CaptureStore.js"
import type { Llm } from "../ports/Llm.js"
import { buildCaptureTools } from "./captureTools.js"
import { notesSystemPrompt } from "../prompts/notes.js"

export interface AgentConfig<R> {
  /** Stable identifier for cache-key isolation across configs in the same conversation. */
  readonly key: string
  readonly systemPrompt: string
  readonly tools: ReadonlyArray<AgentTool<any, any, R>>
}

export const notesAgentConfig: AgentConfig<CaptureStore | Llm> = {
  key: "notes",
  systemPrompt: notesSystemPrompt,
  tools: buildCaptureTools(),
}
