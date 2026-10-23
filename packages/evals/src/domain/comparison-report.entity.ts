import { Schema } from "effect"
import { EvalId } from "./identity.entity.js"
import { GateFinding } from "./evaluation-run.entity.js"

const Finite = Schema.Number.check(Schema.isFinite())
export const ComparisonInterval = Schema.Struct({ estimate: Finite, low: Finite, high: Finite })
export const ComparisonReport = Schema.Struct({
  version: Schema.Literal(1), specification: EvalId, specificationFingerprint: Schema.NonEmptyString,
  baselineRun: EvalId, candidateRun: EvalId,
  verdict: Schema.Literals(["incompatible", "inconclusive", "improved", "regressed"]),
  accepted: Schema.Boolean, issues: Schema.Array(Schema.String), acceptanceIssues: Schema.Array(Schema.String),
  expectedPairs: Schema.Int, measuredPairs: Schema.Int, missingPairs: Schema.Int,
  independentFamilies: Schema.Int, requiredFamilies: Schema.Int,
  baselineUnmeasured: Schema.Int, candidateUnmeasured: Schema.Int,
  secondaryUnmeasured: Schema.Struct({ baseline: Schema.Int, candidate: Schema.Int }),
  tasks: Schema.Array(Schema.Struct({ suiteId: EvalId, taskId: EvalId, family: Schema.String, measuredPairs: Schema.Int, improvement: Schema.OptionFromNullOr(Finite) })),
  regressions: Schema.Array(Schema.String), blockingGates: Schema.Array(GateFinding),
  confidenceLevel: Schema.Literal(0.95), bootstrapSamples: Schema.Literal(10000), seed: Schema.Int,
  /** Positive values always mean improvement, including when smaller raw values are better. */
  improvement: Schema.OptionFromNullOr(ComparisonInterval),
  minimumImprovement: Finite,
  estimand: Schema.Literal("equal-family-mean; repetitions-within-task; tasks-within-family"),
})
export type ComparisonReport = typeof ComparisonReport.Type
