import { Context, Schema } from "effect"
import type { Effect } from "effect"
import { TokenUsage } from "../domain/token-usage.entity.js"

export class UtilityError extends Schema.TaggedError<UtilityError>()("UtilityError", {
  message: Schema.String,
}) {}

export class UtilityCompletion extends Schema.Class<UtilityCompletion>("UtilityCompletion")({
  text: Schema.String,
  usage: TokenUsage,
}) {}

/**
 * One-shot helper completions OFF the agent loop (session titles, digests,
 * quick judgments) — backed by the fast-role model so a helper call is cheap
 * and can never park a turn. Never a substitute for the loop's LanguageModel.
 */
export class UtilityLlm extends Context.Tag("@xandreed/engine/UtilityLlm")<
  UtilityLlm,
  {
    readonly complete: (prompt: string) => Effect.Effect<UtilityCompletion, UtilityError>
  }
>() {}
