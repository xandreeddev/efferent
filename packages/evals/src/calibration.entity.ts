import { Schema } from "effect"
import { EvaluationId, EvaluationSplit, EvaluationTrial } from "./assessment.entity.js"

const Count = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
const Share = Schema.OptionFromNullOr(Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 }))))
const Amount = Schema.OptionFromNullOr(Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))))

/** Fingerprints that must match before two reports of a calibration are compared. */
export const CalibrationIdentity = Schema.Struct({
  calibration: Schema.String,
  datasetHash: Schema.String,
  evaluatorHash: Schema.String,
  subjectHash: Schema.String,
  candidatesHash: Schema.String,
})
export type CalibrationIdentity = typeof CalibrationIdentity.Type

export const MetricSummary = Schema.Struct({ count: Count, mean: Schema.OptionFromNullOr(Schema.Number) })
export type MetricSummary = typeof MetricSummary.Type

export const GateReport = Schema.Struct({
  evaluator: Schema.String,
  metric: Schema.String,
  aggregate: Schema.Literals(["mean", "passRate"]),
  mode: Schema.Literals(["blocking", "diagnostic"]),
  value: Schema.OptionFromNullOr(Schema.Number),
  passed: Schema.Boolean,
  findings: Schema.Array(Schema.String),
})
export type GateReport = typeof GateReport.Type

export const CandidatePerformance = Schema.Struct({
  attempts: Count,
  completed: Count,
  failed: Count,
  cancelled: Count,
  /** Nearest-rank over every attempt, failures included; unavailable without attempts. */
  p50LatencyMs: Amount,
  p95LatencyMs: Amount,
  /** Evaluator usage summed over scored assessments; unavailable when any assessment left it unknown. */
  judgeInputTokens: Amount,
  judgeOutputTokens: Amount,
  judgeCostUsd: Amount,
})
export type CandidatePerformance = typeof CandidatePerformance.Type

export const ReliabilityBin = Schema.Struct({
  lower: Schema.Number,
  upper: Schema.Number,
  count: Count,
  confidence: Share,
  frequency: Share,
})
/** How the subject's metrics agree with reference labels (the judge-calibration summary). */
export const JudgeCalibrationSummary = Schema.Struct({
  total: Count,
  measured: Count,
  unavailable: Count,
  agreement: Share,
  brier: Amount,
  absoluteError: Amount,
  confusion: Schema.Struct({ truePositive: Count, trueNegative: Count, falsePositive: Count, falseNegative: Count }),
  precision: Share,
  recall: Share,
  falsePassRate: Share,
  falseFailRate: Share,
  reliability: Schema.Array(ReliabilityBin),
})
export type JudgeCalibrationSummary = typeof JudgeCalibrationSummary.Type

export const CandidateReport = Schema.Struct({
  id: Schema.String,
  candidate: Schema.Record(Schema.String, Schema.Unknown),
  trials: Schema.Array(EvaluationId),
  /** Keyed `evaluator/metric`, over scored assessments. */
  metrics: Schema.Record(Schema.String, MetricSummary),
  gates: Schema.Array(GateReport),
  /** Every trial completed and every blocking gate passed. */
  passed: Schema.Boolean,
  calibration: Schema.OptionFromNullOr(JudgeCalibrationSummary),
  performance: CandidatePerformance,
})
export type CandidateReport = typeof CandidateReport.Type

export const CalibrationRunSettings = Schema.Struct({
  runId: Schema.String,
  split: EvaluationSplit,
  repetitions: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  concurrency: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  timeoutMs: Schema.Number.pipe(Schema.check(Schema.isGreaterThan(0))),
})
export type CalibrationRunSettings = typeof CalibrationRunSettings.Type

export const CalibrationReport = Schema.Struct({
  version: Schema.Literal(1),
  calibration: Schema.Struct({ id: Schema.String, version: Schema.String }),
  identity: CalibrationIdentity,
  run: CalibrationRunSettings,
  /** Every case in the split is known or reviewed; provisional labels cannot promote. */
  reviewed: Schema.Boolean,
  trials: Schema.Array(EvaluationTrial),
  candidates: Schema.Array(CandidateReport),
  failures: Schema.Array(Schema.Struct({ candidate: Schema.String, reason: Schema.String })),
  /** The first candidate of the host's selection, when a policy was declared. */
  recommendation: Schema.OptionFromNullOr(Schema.String),
  /** The recommendation passed every blocking gate on reviewed labels, with no failures. */
  promotionEligible: Schema.Boolean,
})
export type CalibrationReport = typeof CalibrationReport.Type
