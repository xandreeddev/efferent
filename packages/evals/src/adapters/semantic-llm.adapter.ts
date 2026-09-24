import { LanguageModel } from "@effect/ai"
import type { Prompt } from "@effect/ai"
import { Effect, Layer, Option } from "effect"
import { AssessmentError } from "../assessment.entity.js"
import type { SemanticInput } from "../semantic.entity.js"
import { semanticResponseSchema, validateSemanticInput, validateSemanticAnswers } from "../semantic.entity.functions.js"
import { SemanticJudge } from "../ports/semantic-judge.port.js"

export interface SemanticLlmOptions {
  readonly id: string
  readonly prompt: (input: SemanticInput) => Prompt.Prompt
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** Captures the supplied model service; each profile can supply its own native prompt builder. */
export const makeSemanticLlmJudge = (options: SemanticLlmOptions) => Effect.gen(function* () {
  const model = yield* LanguageModel.LanguageModel
  return SemanticJudge.of({
    id: options.id,
    evaluate: (input) => Effect.gen(function* () {
      yield* validateSemanticInput(input)
      const response = yield* model.generateObject({
        prompt: options.prompt(input), schema: semanticResponseSchema(input.questions), objectName: "semantic_assessment",
      }).pipe(Effect.mapError((error) => new AssessmentError({ code: "provider", message: String(error) })))
      const answers = yield* validateSemanticAnswers(input, response.value.answers)
      return { answers, usage: { inputTokens: Option.fromNullable(response.usage.inputTokens), outputTokens: Option.fromNullable(response.usage.outputTokens), costUsd: Option.none<number>() }, metadata: options.metadata ?? {} }
    }).pipe(Effect.withSpan("eval.semantic.llm", { attributes: { "eval.backend": options.id } })),
  })
})

export const SemanticLlmLive = (options: SemanticLlmOptions) => Layer.effect(SemanticJudge, makeSemanticLlmJudge(options))
