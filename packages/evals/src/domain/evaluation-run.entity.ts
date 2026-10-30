import { Schema } from "effect"
import { EvalId, Fingerprints } from "./identity.entity.js"
import { Trial } from "./trial.entity.js"
import { Gate } from "./suite.entity.js"

/**
 * A gate's verdict for one candidate; its grader, metric and mode are the gate's own.
 *
 * @public
 */
export const GateFinding = Schema.Struct({ candidate: EvalId, grader: Gate.fields.grader, metric: Gate.fields.metric, mode: Gate.fields.mode, passed: Schema.Boolean, measured: Schema.Int, value: Schema.OptionFromNullOr(Schema.Number), reason: Schema.String })
export const EvaluationRun = Schema.Struct({
  version: Schema.Literal(1), id: EvalId, application: Schema.NonEmptyString,
  phase: Schema.Literals(["executed", "graded"]),
  startedAt: Schema.Number, endedAt: Schema.Number, fingerprints: Fingerprints,
  trials: Schema.Array(Trial), gates: Schema.Array(GateFinding), failures: Schema.Array(Schema.String),
})
export type EvaluationRun = typeof EvaluationRun.Type
