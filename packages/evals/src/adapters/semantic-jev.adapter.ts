import { Effect, Layer, Schema } from "effect"
import { AssessmentError } from "../assessment.entity.js"
import { unknownEvaluationUsage } from "../assessment.usecase.functions.js"
import type { SemanticInput } from "../semantic.entity.js"
import { validateSemanticInput, validateSemanticAnswers } from "../semantic.entity.functions.js"
import { SemanticJudge } from "../ports/semantic-judge.port.js"

/** Optional transport bridge. The host binds its Gateway evaluation model and SDK version. */
export interface SemanticJevOptions {
  readonly evaluate: (input: SemanticInput, signal: AbortSignal) => PromiseLike<{ readonly answers: unknown }>
  readonly maxInputBytes?: number
  readonly timeoutMs?: number
  readonly metadata?: Readonly<Record<string, unknown>>
}

export const makeSemanticJevJudge = (options: SemanticJevOptions) => Effect.gen(function* () {
  const maxInputBytes = options.maxInputBytes ?? 24_000
  const timeoutMs = options.timeoutMs ?? 10_000
  if (!Number.isInteger(maxInputBytes) || maxInputBytes < 1 || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
    return yield* Effect.fail(new AssessmentError({ code: "invalid", message: "Jev input limit and deadline must be positive" }))
  return SemanticJudge.of({
    id: "jev",
    evaluate: (input) => Effect.gen(function* () {
      yield* validateSemanticInput(input)
      if (new TextEncoder().encode(JSON.stringify(input)).byteLength > maxInputBytes)
        return yield* Effect.fail(new AssessmentError({ code: "invalid", message: "Jev input exceeds its byte limit" }))
      const response = yield* Effect.tryPromise({
        try: (signal) => options.evaluate(input, signal),
        catch: (error) => new AssessmentError({ code: "provider", message: String(error) }),
      }).pipe(Effect.timeoutFail({ duration: timeoutMs, onTimeout: () => new AssessmentError({ code: "timeout", message: "Jev deadline exceeded" }) }))
      const decoded = yield* Schema.decodeUnknown(Schema.Struct({ answers: Schema.Unknown }))(response).pipe(
        Effect.mapError((error) => new AssessmentError({ code: "invalid", message: String(error) })),
      )
      const answers = yield* validateSemanticAnswers(input, decoded.answers)
      return { answers, usage: unknownEvaluationUsage, metadata: { ...options.metadata, model: "typesafe-ai/jev" } }
    }).pipe(Effect.withSpan("eval.semantic.jev", { attributes: { "gen_ai.request.model": "typesafe-ai/jev" } })),
  })
})

export const SemanticJevLive = (options: SemanticJevOptions) => Layer.effect(SemanticJudge, makeSemanticJevJudge(options))
