import { Option } from "effect"
import type { EvaluationResult } from "./assessment.entity.js"
import type { EvaluationScore } from "./evaluation-score.entity.js"

export const evaluationScores = (result: EvaluationResult): ReadonlyArray<EvaluationScore> =>
  result.status === "scored" ? result.metrics.map((metric) => ({
    key: metric.name, score: metric.value,
    comment: metric.comment ?? Option.getOrElse(result.reason, () => ""),
  })) : []
