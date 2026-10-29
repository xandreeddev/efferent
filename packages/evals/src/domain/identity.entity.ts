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
/** An identifier composed of `EvalId` segments joined by "/": a trial's or a transcript event's. */
export const EvalPath = Schema.NonEmptyString.check(
  Schema.isPattern(/^[^/@]+(?:\/[^/@]+)*$/, { message: "a path is ids joined by \"/\", without \"@\" or empty segments" })
).pipe(Schema.brand("EvalPath"))
export type EvalPath = typeof EvalPath.Type
export const Version = Schema.NonEmptyString
export const Fingerprints = Schema.Record(Schema.String, Schema.String)
export class EvaluationError extends Schema.TaggedError<EvaluationError>()("EvaluationError", {
  code: Schema.Literals(["invalid", "missing", "unavailable", "execution", "persistence", "provider", "budget", "timeout"]),
  message: Schema.String,
}) {}
