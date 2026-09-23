import { LanguageModel } from "@effect/ai"
import type { Prompt } from "@effect/ai"
import { Effect, Option, Schema } from "effect"
import { AssessmentError } from "../assessment.entity.js"
import type { Assessment, Evaluator } from "../assessment.usecase.js"

/** The host provides its native model Layer, prompt builder and rubric schema. */
export const llmEvaluator = <I, A, Encoded extends Record<string, unknown>>(options: {
  readonly id: string
  readonly version: string
  readonly metrics: ReadonlyArray<string>
  readonly prompt: (input: I) => Prompt.Prompt
  readonly schema: Schema.Schema<A, Encoded>
  readonly assessment: (value: A) => Assessment
}): Evaluator<I, LanguageModel.LanguageModel> => ({
  id: options.id, version: options.version, metrics: options.metrics,
  run: (input) => LanguageModel.generateObject({ prompt: options.prompt(input), schema: options.schema, objectName: options.id.replaceAll(/[^a-zA-Z0-9_]/g, "_") }).pipe(
    Effect.map((response) => ({ ...options.assessment(response.value), usage: { inputTokens: Option.fromNullable(response.usage.inputTokens), outputTokens: Option.fromNullable(response.usage.outputTokens), costUsd: Option.none<number>() } })),
    Effect.mapError((error) => new AssessmentError({ code: "provider", message: String(error) })),
  ),
})
