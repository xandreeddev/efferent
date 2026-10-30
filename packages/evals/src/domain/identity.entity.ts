import { Schema } from "effect"

/**
 * A chosen identifier (a suite's, task's, candidate's, runnable's, grader's,
 * projection's, calibration's or run's): one segment without "/" or "@", so
 * the ids composed from it (a trial's `run/suite/candidate/task/sample`) and
 * grader keys (`<id>@<version>`) read back unambiguously.
 */
export const EvalId = Schema.NonEmptyString.check(
  Schema.isPattern(/^[^/@]+$/, { message: "an id is one segment, without \"/\" or \"@\"" })
).pipe(Schema.brand("EvalId"))
export type EvalId = typeof EvalId.Type
/**
 * An identifier composed of `EvalId` segments joined by "/": a trial's or a transcript event's.
 *
 * @public
 */
export const EvalPath = Schema.NonEmptyString.check(
  Schema.isPattern(/^[^/@]+(?:\/[^/@]+)*$/, { message: "a path is ids joined by \"/\", without \"@\" or empty segments" })
).pipe(Schema.brand("EvalPath"))
export type EvalPath = typeof EvalPath.Type
/** @public */
export const Version = Schema.NonEmptyString
/** @public */
export const Fingerprints = Schema.Record(Schema.String, Schema.String)
/**
 * One reason an evaluation app is refused: `shape` when a value is not what
 * the app's type declares, a cross-reference rule otherwise. `path` leads
 * from the app to the offending value (`["suites", 0, "tasks", 1, "runnable"]`).
 *
 * @public
 */
export const AppViolation = Schema.Struct({
  rule: Schema.Literals([
    "shape", "id-empty", "duplicate-id", "suite-empty", "task-ungraded", "binding-duplicate",
    "split-mixed", "runnable-unknown", "environment-unregistered", "grader-unknown", "projection-unknown",
    "gate-unbound", "gate-metric-unknown",
  ]),
  path: Schema.Array(Schema.Union([Schema.String, Schema.Int])),
  message: Schema.String,
})
export type AppViolation = typeof AppViolation.Type
/**
 * `message` says what failed; `cause` keeps the failure it wraps (a schema or
 * provider error) for an operator, never for a report; `violations` lists
 * every reason a refused evaluation app was refused.
 */
export class EvaluationError extends Schema.TaggedError<EvaluationError>()("EvaluationError", {
  code: Schema.Literals(["invalid", "missing", "unavailable", "execution", "persistence", "provider", "budget", "timeout"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
  violations: Schema.optionalKey(Schema.Array(AppViolation)),
}) {}
