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

/**
 * One-shot text completion on the **cheap** model role — the background tier
 * for work that shouldn't burn main-tier tokens or latency: session titles
 * today, tool/result summaries later. Selection: `Settings.cheapModel`
 * (legacy `utilityModel` honored), unset → the current main selection, so the
 * capability works out of the box and gets cheaper the moment one
 * `:set cheapModel …` lands. Deliberately tiny (a prompt in, a completion
 * out): callers own their prompts and parsing. Usage is reported so the
 * cheap tier's spend is countable like every other role's.
 */
export class UtilityLlm extends Context.Tag("@efferent/core/UtilityLlm")<
  UtilityLlm,
  {
    readonly complete: (prompt: string) => Effect.Effect<UtilityCompletion, UtilityLlmError>
  }
>() {}
