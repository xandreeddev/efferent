import { GraderAssessment } from "../../ports/grader-assessment.port.js"
import { Effect, Option, Schema, Layer } from "effect"
import { EvalId, EvaluationError } from "../../domain/identity.entity.js"
import type { GraderRegistration } from "../../contracts/evaluation-app.contract.js"
import { unknownEvaluationUsage } from "../../assessment.usecase.functions.js"
import { fingerprint } from "../../domain/grading-context.entity.functions.js"
import {
  RetrievalContext,
  RetrievalJudgement,
  type RetrievalItem,
  type RetrievalMeasure
} from "./semantic-retrieval.entity.js"
import { retrievalItems } from "./semantic-retrieval.entity.functions.js"
import { contextualPrecision } from "./contextual-precision.functions.js"
import { contextualRecall } from "./contextual-recall.functions.js"
import { contextualRelevancy } from "./contextual-relevancy.functions.js"

/**
 * A measure's judge: the projected context (for contextual relevancy without
 * the expected claims) and the units to rule on (`retrievalItems`), each
 * with the id its verdict must carry, one verdict per id. Its answer is
 * decoded (`RetrievalJudgement`), so its ids may be plain strings.
 *
 * @public
 */
export type RetrievalJudge = (
  measure: RetrievalMeasure,
  input: RetrievalContext,
  items: ReadonlyArray<RetrievalItem>
) => Effect.Effect<typeof RetrievalJudgement.Encoded, EvaluationError>

/**
 * `rubric`: what each measure's judge works from, its prompt or the template
 * the prompt is built from. The grader's `rubric` fingerprint is taken from
 * it, so reports graded under different prompts do not compare as alike.
 * Without one, the fingerprint names only the measure's definition
 * (`retrieval-<measure>:1`), the same whatever the judge's prompt.
 *
 * @public
 */
export type SemanticRetrievalOptions = {
  readonly rubric?: Readonly<Partial<Record<RetrievalMeasure, string>>>
}

/**
 * The application binds its judge model and cost guard. No provider SDK enters the domain.
 *
 * @public
 */
export const semanticRetrievalGraders = (
  judge: RetrievalJudge,
  options: SemanticRetrievalOptions = {}
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
      fingerprints: {
        rubric: Option.match(Option.fromNullishOr(options.rubric?.[measure]), {
          onNone: () => `retrieval-${measure}:1`,
          onSome: (rubric) => `retrieval-${measure}:1:${fingerprint({ measure, rubric })}`
        })
      }
    },
    layer: Layer.succeed(GraderAssessment, {
      assess: Effect.fn("eval.retrieval.assess", { attributes: { "eval.retrieval.measure": measure } })(
        function* (context) {
          const input = yield* Schema.decodeUnknownEffect(RetrievalContext)(
            context.input
          ).pipe(
            Effect.mapError(
              (error) =>
                new EvaluationError({
                  code: "invalid",
                  message: `Retrieval context does not decode: ${error.message}`,
                  cause: error
                })
            )
          )
          const items = retrievalItems(measure, input)
          const expectedIds = items.map((item) => item.id)
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
              : input,
            items
          )
          const verdict = yield* Schema.decodeUnknownEffect(RetrievalJudgement)(
            judgement
          ).pipe(
            Effect.mapError(
              (error) =>
                new EvaluationError({
                  code: "invalid",
                  message: `Judge verdict does not decode: ${error.message}`,
                  cause: error
                })
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
        }
      )
    })
  }))
