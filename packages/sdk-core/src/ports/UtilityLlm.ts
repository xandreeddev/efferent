import { Context, Data, type Effect } from "effect"
import type { TokenUsage } from "./LlmInfo.js"

/** A utility completion failed (provider error, missing key, bad selection). */
export class UtilityLlmError extends Data.TaggedError("UtilityLlmError")<{
  readonly message: string
}> {}

/** A utility completion: the text plus what it cost (when the provider said). */
export interface UtilityCompletion {
  readonly text: string
  readonly usage?: TokenUsage
}

/** Which helper tier a one-shot completion runs on. */
export interface UtilityOptions {
  /**
   * `fast` — helper calls inside a running turn: tool-output summaries,
   * auto-approval judgments, session titles. Resolves through `fastModel`,
   * unset → the current main selection.
   */
  readonly role?: "fast"
}

/**
 * One-shot text completion on a helper model role — the doorway every
 * non-agentic LLM call goes through (the agent loop itself always runs on
 * main; sub-agents too — delegation changes the context, not the brain).
 * Deliberately tiny (a prompt in, a completion out): callers own their
 * prompts and parsing. Usage is reported so each tier's spend is countable.
 */
export class UtilityLlm extends Context.Tag("@xandreed/sdk-core/UtilityLlm")<
  UtilityLlm,
  {
    readonly complete: (
      prompt: string,
      options?: UtilityOptions,
    ) => Effect.Effect<UtilityCompletion, UtilityLlmError>
  }
>() {}
