import { Schema } from "effect"
import { EvaluationUsage } from "./assessment.entity.js"
import { EvalPath } from "./domain/identity.entity.js"
import { Grade } from "./domain/grader.entity.js"

/**
 * One measured metric of a `scored` grade as a remote score, every value as
 * the run encodes it (an absent one is `null`). `trial` is the local trial's
 * id, `key` names the score (`<grader>@<version>/<scope>/<metric>`), and
 * `seed` (`<trial>/<grader>/<version>/<scope>/<metric>`) is what an exporter
 * derives the score's remote id from: it never changes, so exporting a run
 * again updates the scores the last export made. `value` is the metric's
 * number (a boolean is 0 or 1), `comment` the grade's reason, `at` the
 * grade's end.
 *
 * @public
 */
export const ExportedScore = Schema.Struct({
  trial: Schema.toEncoded(EvalPath), key: Schema.NonEmptyString, seed: Schema.NonEmptyString,
  value: Schema.Finite, comment: Schema.String, at: Schema.Number,
  context: Schema.toEncoded(Grade.fields.context), usage: Schema.toEncoded(EvaluationUsage),
})
export type ExportedScore = typeof ExportedScore.Type
