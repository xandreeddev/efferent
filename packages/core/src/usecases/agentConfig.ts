import type { AgentTool } from "../entities/AgentTool.js"

export interface AgentConfig<R> {
  /** Stable identifier for cache-key isolation across configs in the same conversation. */
  readonly key: string
  readonly systemPrompt: string
  readonly tools: ReadonlyArray<AgentTool<any, any, R>>
}
