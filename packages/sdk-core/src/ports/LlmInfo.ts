import { Context, type Effect } from "effect"
import type { TokenUsage } from "../entities/TokenUsage.js"

export { type TokenUsage } from "../entities/TokenUsage.js"

export interface LlmMetadata {
  readonly modelId: string
  /** Total context window the model accepts (input + output). */
  readonly contextWindow: number
}

/**
 * Static description of the configured smart-tier model. Read once at
 * startup by drivers that surface it — e.g. the TUI status bar prints
 * `<modelId>  [gauge] <tokens>/<contextWindow>  <cwd>`.
 */
export class LlmInfo extends Context.Tag("@xandreed/sdk-core/LlmInfo")<
  LlmInfo,
  {
    readonly metadata: Effect.Effect<LlmMetadata, never>
  }
>() {}
