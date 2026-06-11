import { Context, Data, type Effect } from "effect"

/** A utility completion failed (provider error, missing key, bad selection). */
export class UtilityLlmError extends Data.TaggedError("UtilityLlmError")<{
  readonly message: string
}> {}

/**
 * One-shot text completion on the configured CHEAP model — the background tier
 * for things that shouldn't burn the chat model's tokens or latency: session
 * titles today, tool/result summaries later. Selection comes from
 * `Settings.utilityModel` ("<provider>:<modelId>"); unset falls back to the
 * current chat model, so the capability works out of the box and gets cheaper
 * the moment one `:set utilityModel …` lands. Deliberately tiny (a prompt in,
 * a string out): callers own their prompts and parsing.
 */
export class UtilityLlm extends Context.Tag("@efferent/core/UtilityLlm")<
  UtilityLlm,
  {
    readonly complete: (prompt: string) => Effect.Effect<string, UtilityLlmError>
  }
>() {}
