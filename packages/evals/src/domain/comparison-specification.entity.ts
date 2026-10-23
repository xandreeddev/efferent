import { Schema } from "effect"
import { EvalId, Fingerprints } from "./identity.entity.js"
import { Candidate } from "./candidate.entity.js"
import { Gate } from "./suite.entity.js"

export const ComparisonSide = Schema.Literals(["baseline", "candidate"])
export type ComparisonSide = typeof ComparisonSide.Type
const Positive = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
export const ComparisonSubject = Schema.Struct({ candidate: Candidate, fingerprints: Fingerprints })
export const ComparisonTask = Schema.Struct({ suiteId: EvalId, taskId: EvalId, fingerprint: Schema.NonEmptyString })
export const ComparisonGate = Schema.Struct({ suiteId: EvalId, gate: Gate })

/** A prospective comparison of exactly two frozen configurations and one primary metric. */
export const ComparisonSpecification = Schema.Struct({
  version: Schema.Literal(1), id: EvalId, application: Schema.NonEmptyString,
  hypothesis: Schema.NonEmptyString,
  baseline: ComparisonSubject, candidate: ComparisonSubject,
  allowedFingerprintChanges: Schema.Array(Schema.NonEmptyString),
  tasks: Schema.Array(ComparisonTask), repetitions: PositiveInt,
  execution: Schema.Array(Schema.Struct({ suiteId: EvalId, timeoutMs: Positive, concurrency: PositiveInt, environments: Fingerprints })),
  gradingConfiguration: Schema.NonEmptyString, gates: Schema.Array(ComparisonGate),
  primary: Schema.Struct({
    grader: Schema.NonEmptyString, metric: Schema.NonEmptyString,
    direction: Schema.Literals(["higher", "lower"]),
  }),
  minimumImprovement: Positive,
  plannedIndependentFamilies: PositiveInt,
  targetPower: Schema.Literal(0.8), powerRationale: Schema.NonEmptyString,
  seed: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4294967295 })),
})
export type ComparisonSpecification = typeof ComparisonSpecification.Type
export const ComparisonExecution = Schema.Struct({ specification: ComparisonSpecification, side: ComparisonSide })
export type ComparisonExecution = typeof ComparisonExecution.Type
