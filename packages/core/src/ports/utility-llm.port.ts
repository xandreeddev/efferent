import { Context, Option, Schema } from "effect"
import type { Effect } from "effect"
import type { KnowledgeHelperCall } from "../knowledge/knowledge.entity.js"
import { TokenUsage } from "../domain/token-usage.entity.js"
import { ModelSelection } from "../domain/model-selection.entity.js"

/** A helper completion failed; `cause` is the provider's failure underneath, when there is one. */
export class UtilityError extends Schema.TaggedError<UtilityError>()("UtilityError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class UtilityCompletion extends Schema.Class<UtilityCompletion>("UtilityCompletion")({
  text: Schema.String,
  usage: TokenUsage,
  /** Actual invoked selection when known; absent for opaque/legacy helpers. */
  model: Schema.optionalKey(ModelSelection),
}) {}

/**
 * One-shot helper completions OFF the agent loop (session titles, digests,
 * quick judgments) — backed by the fast-role model so a helper call is cheap
 * and can never park a turn. Never a substitute for the loop's LanguageModel.
 * An adapter reads what a knowledge engine's call is for from
 * `CurrentKnowledgeHelperCall`.
 */
export class UtilityLlm extends Context.Service<UtilityLlm, {
    readonly complete: (prompt: string) => Effect.Effect<UtilityCompletion, UtilityError>
  }>()("@xandreed/core/UtilityLlm") {}

/**
 * What the current helper call is for, when a knowledge engine makes it: the
 * memory and document engines provide it around each `UtilityLlm.complete`
 * (extraction, review, search planning, reranking), so an adapter can budget,
 * attribute or refuse the call by purpose, scope, job or output cap. Absent
 * for any other helper call.
 * @public
 */
export const CurrentKnowledgeHelperCall = Context.Reference<Option.Option<KnowledgeHelperCall>>("@xandreed/core/CurrentKnowledgeHelperCall", { defaultValue: () => Option.none() })
