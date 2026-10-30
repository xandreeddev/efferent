import { LanguageModel } from "effect/ai"
import type { Prompt } from "effect/ai"
import { Effect, Layer, Option, type Schema } from "effect"
import { assessmentOfAiError } from "../assessment.entity.functions.js"
import type { SemanticInput } from "../semantic.entity.js"
import { semanticResponseSchema, validateSemanticInput, validateSemanticAnswers } from "../semantic.entity.functions.js"
import { SemanticJudge } from "../ports/semantic-judge.port.js"

/** @public */
export interface SemanticLlmOptions {
  readonly id: string
  readonly prompt: (input: SemanticInput) => Prompt.Prompt
  readonly metadata?: Schema.JsonObject
}

/**
 * Captures the supplied model service; each profile can supply its own native prompt builder.
 *
 * @public
 */
export const makeSemanticLlmJudge = Effect.fnUntraced(function* (options: SemanticLlmOptions) {
  const model = yield* LanguageModel.LanguageModel
  return SemanticJudge.of({
    id: options.id,
    evaluate: Effect.fn("eval.semantic.llm", { attributes: { "eval.backend": options.id } })(function* (input) {
      yield* validateSemanticInput(input)
      const response = yield* model.generateObject({
        prompt: options.prompt(input), schema: semanticResponseSchema(input.questions), objectName: "semantic_assessment",
      }).pipe(Effect.mapError(assessmentOfAiError))
      const answers = yield* validateSemanticAnswers(input, response.value.answers)
      return { answers, usage: { inputTokens: Option.fromNullishOr(response.usage.inputTokens.total), outputTokens: Option.fromNullishOr(response.usage.outputTokens.total), costUsd: Option.none<number>() }, metadata: options.metadata ?? {} }
    }),
  })
})

export const SemanticLlmLive = (options: SemanticLlmOptions) => Layer.effect(SemanticJudge, makeSemanticLlmJudge(options))
