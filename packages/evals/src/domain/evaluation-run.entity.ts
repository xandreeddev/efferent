import { Schema } from "effect"
import { EvalId, Fingerprints } from "./identity.entity.js"
import { Trial } from "./trial.entity.js"
import { Gate } from "./suite.entity.js"
import { RunSpend } from "./spend.entity.js"

/**
 * A gate's verdict for one candidate; its grader, metric and mode are the gate's own, and so are `aggregate` and the
 * bounds it was held to (`minimum`, `maximum`, each present when the gate has a finite one), so a finding reads without its
 * suite. Runs recorded before they were written lack all three: the keys are optional, and such reports decode
 * unchanged.
 *
 * @public
 */
export const GateFinding = Schema.Struct({ candidate: EvalId, grader: Gate.fields.grader, metric: Gate.fields.metric, mode: Gate.fields.mode, passed: Schema.Boolean, measured: Schema.Int, value: Schema.OptionFromNullOr(Schema.Number), reason: Schema.String,
  aggregate: Schema.optionalKey(Gate.fields.aggregate), minimum: Schema.optionalKey(Schema.Finite), maximum: Schema.optionalKey(Schema.Finite) })
/**
 * A run: its trials, gate findings and failures (trials that did not
 * complete but those its spend budget skipped, and grades in error or
 * unavailable), and `spend`, recorded when the run had a budget or any trial
 * reserved spend.
 */
export const EvaluationRun = Schema.Struct({
  version: Schema.Literal(1), id: EvalId, application: Schema.NonEmptyString,
  phase: Schema.Literals(["executed", "graded"]),
  startedAt: Schema.Number, endedAt: Schema.Number, fingerprints: Fingerprints,
  trials: Schema.Array(Trial), gates: Schema.Array(GateFinding), failures: Schema.Array(Schema.String),
  spend: Schema.optionalKey(RunSpend),
})
export type EvaluationRun = typeof EvaluationRun.Type
