import type { Tool, Toolkit } from "@effect/ai"
import type { CompressionPolicy } from "../entities/Compression.js"
import type { Prompt } from "../entities/Prompt.js"

/**
 * A versioned system prompt bundled with an `@effect/ai` `Toolkit`. The handler
 * Layer for the toolkit is provided separately at the driver's
 * composition root (it carries the runtime deps like `cwd`/`FileSystem`).
 */
export interface AgentConfig<Tools extends Record<string, Tool.Any>> {
  /** Stable identifier for cache-key isolation across configs in a conversation. */
  readonly key: string
  /** The prompt (name/version + rendered text) this agent runs with. */
  readonly prompt: Prompt
  readonly toolkit: Toolkit.Toolkit<Tools>
  /**
   * How this agent keeps its context small. Absent ⇒ the SDK default
   * (`Headroom.default()`: headroom tail compression + identity context), so
   * behaviour is unchanged. `Compression.none` disables it; a composed or
   * hand-written {@link CompressionPolicy} replaces it. The policy is inherited
   * by this agent's sub-agents (threaded via `RunContext`).
   */
  readonly compression?: CompressionPolicy
}
