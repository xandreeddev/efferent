import { Context, type Effect } from "effect"

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
export class LlmInfo extends Context.Tag("@agent/core/LlmInfo")<
  LlmInfo,
  {
    readonly metadata: Effect.Effect<LlmMetadata, never>
  }
>() {}
