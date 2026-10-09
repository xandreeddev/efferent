import { GraderAssessment } from "../../ports/grader-assessment.port.js"
import { Effect, Option, Schema, Layer } from "effect"
import { EvalId, EvaluationError } from "../../domain/identity.entity.js"
import type { GraderRegistration } from "../../contracts/evaluation-app.contract.js"
import { unknownEvaluationUsage } from "../../assessment.usecase.functions.js"
import {
  RetrievalContext,
  RetrievalJudgement,
  type RetrievalMeasure
} from "./semantic-retrieval.entity.js"
import { contextualPrecision } from "./contextual-precision.functions.js"
import { contextualRecall } from "./contextual-recall.functions.js"
import { contextualRelevancy } from "./contextual-relevancy.functions.js"

/** The application binds its judge model and cost guard. No provider SDK enters the domain. */
export const semanticRetrievalGraders = (
  judge: (
    measure: RetrievalMeasure,
    input: RetrievalContext
  ) => Effect.Effect<RetrievalJudgement, EvaluationError>
): ReadonlyArray<GraderRegistration> =>
  (
    [
      "contextual-precision",
      "contextual-recall",
      "contextual-relevancy"
    ] as const
  ).map((measure) => ({
    definition: {
      id: EvalId.make(`retrieval.${measure}`),
      version: "1",
      kind: "model",
      metrics: [measure],
      fingerprints: { rubric: `retrieval-${measure}:1` }
    },
    layer: Layer.succeed(GraderAssessment, {
      assess: (context) =>
        Effect.gen(function* () {
          const input = yield* Schema.decodeUnknownEffect(RetrievalContext)(
            context.input
          ).pipe(
            Effect.mapError(
              (error) =>
                new EvaluationError({ code: "invalid", message: String(error) })
            )
          )
          const expectedIds =
            measure === "contextual-recall"
              ? input.expectedClaims.map((_, index) => `claim:${index}`)
              : measure === "contextual-relevancy"
                ? input.documents.flatMap((document) =>
                    document.statements.map(
                      (_, index) => `${document.id}/statement:${index}`
                    )
                  )
                : input.documents.map((document) => document.id)
          if (
            !expectedIds.length ||
            new Set(expectedIds).size !== expectedIds.length
          )
            return yield* Effect.fail(
              new EvaluationError({
                code: "unavailable",
                message:
                  "Retrieval grading needs nonempty, uniquely identified documents or expected claims"
              })
            )
          const judgement = yield* judge(
            measure,
            measure === "contextual-relevancy"
              ? { ...input, expectedClaims: [] }
              : input
          )
          const verdict = yield* Schema.decodeUnknownEffect(RetrievalJudgement)(
            judgement
          ).pipe(
            Effect.mapError(
              (error) =>
                new EvaluationError({ code: "invalid", message: String(error) })
            )
          )
          if (
            verdict.verdicts.length !== expectedIds.length ||
            expectedIds.some(
              (id) =>
                verdict.verdicts.filter((item) => item.id === id).length !== 1
            )
          )
            return yield* Effect.fail(
              new EvaluationError({
                code: "invalid",
                message:
                  "Judge verdict coverage does not match the projected context"
              })
            )
          const values = expectedIds.map(
            (id) => verdict.verdicts.find((item) => item.id === id)!.relevant
          )
          const value =
            measure === "contextual-precision"
              ? Option.some(contextualPrecision(values))
              : measure === "contextual-recall"
                ? contextualRecall(values)
                : contextualRelevancy(values)
          return {
            status: "scored" as const,
            metrics: [
              {
                kind: "probability" as const,
                name: measure,
                value: Option.getOrElse(value, () => 0)
              }
            ],
            reason: verdict.verdicts
              .map((item) => `${item.id}: ${item.reason}`)
              .join("\n"),
            usage: unknownEvaluationUsage,
            metadata: { verdicts: verdict.verdicts }
          }
        })
    })
  }))
