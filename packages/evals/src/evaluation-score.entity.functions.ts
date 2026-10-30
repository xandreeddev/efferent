import { Match, Option } from "effect"
import type { Metric } from "./assessment.entity.js"
import type { EvaluationRun } from "./domain/evaluation-run.entity.js"
import type { ExportedScore } from "./evaluation-score.entity.js"

/** A metric as a remote score's number: a boolean is 0 or 1; a preference has none and stays local. */
const scoreValue = (metric: typeof Metric.Encoded): Option.Option<number> =>
  Match.value(metric).pipe(
    Match.discriminatorsExhaustive("kind")({
      boolean: ({ value }) => Option.some(Number(value)),
      probability: ({ value }) => Option.some(value),
      score: ({ value }) => Option.some(value),
      preference: () => Option.none(),
    }),
  )

/**
 * The scores every exporter sends, in the run's order: each `boolean`,
 * `probability` and `score` metric of each `scored` grade. It reads the run
 * as it encodes, so no in-memory `Option` reaches a remote API.
 */
export const exportableScores = (encoded: typeof EvaluationRun.Encoded): ReadonlyArray<ExportedScore> =>
  encoded.trials.flatMap((trial) =>
    trial.grades
      .filter((grade) => grade.status === "scored")
      .flatMap((grade) =>
        grade.metrics.flatMap((metric) =>
          Option.toArray(Option.map(scoreValue(metric), (value) => ({
            trial: trial.id,
            key: `${grade.grader}@${grade.version}/${grade.scope}/${metric.name}`,
            seed: `${trial.id}/${grade.grader}/${grade.version}/${grade.scope}/${metric.name}`,
            value,
            comment: grade.reason,
            at: grade.endedAt,
            context: grade.context,
            usage: grade.usage,
          }))),
        ),
      ),
  )
