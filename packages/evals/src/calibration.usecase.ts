import type { Effect, Layer, Schema, Scope } from "effect"
import type { AssessmentError, EvaluationSplit, Metric } from "./assessment.entity.js"
import type { AssessmentInput, Dataset, EvaluatorBinding } from "./assessment.usecase.js"
import type { CandidateReport } from "./calibration.entity.js"

/**
 * A calibration is one of the two kinds of eval (the other is a journey): one
 * subject under test, run over a labelled dataset for every candidate, scored
 * by evaluators and judges, then held to gates. The whole setup is this one
 * value; `runCalibration` runs it on a split.
 */
export interface CalibrationSubject<I, O, E, C, R, Shared> {
  /** Runs one case. It receives the input only; the reference reaches evaluators afterwards. */
  readonly task: (input: I) => Effect.Effect<{ readonly output: O; readonly evidence: E }, AssessmentError, R | Scope.Scope>
  /** The services the task and the evaluators run on for a candidate. Built fresh for every case. */
  readonly services: (candidate: C) => Layer.Layer<R, never, Shared>
  /** Identity of the code under test (prompt ids, versions, hashes); part of the report identity. */
  readonly fingerprints: Readonly<Record<string, string>>
}

/** A threshold on one metric aggregated over a candidate's trials of a run. */
export interface AggregateGate {
  readonly evaluator: string
  readonly metric: string
  /** `mean` over scored values; `passRate` counts trials whose value is exactly 1 (failed trials count as not passed). */
  readonly aggregate: "mean" | "passRate"
  readonly minimum?: number
  readonly maximum?: number
  /** Diagnostic gates are reported, never enforced. */
  readonly mode: "blocking" | "diagnostic"
  /** The gate fails while any case in the split is still provisional. */
  readonly requiresReviewedReference?: boolean
}

/** How a subject's output and a case's reference become comparable metrics (judge calibration). */
export interface JudgeCalibration<Ref, O> {
  readonly reference: (reference: Ref) => ReadonlyArray<Metric>
  readonly actual: (output: O) => ReadonlyArray<Metric>
}

/** A candidate's report with its typed candidate, for the host's selection policy. */
export interface CandidateSummary<C> extends Omit<CandidateReport, "candidate"> {
  readonly candidate: C
}

export interface CalibrationRunDefaults {
  readonly repetitions: number
  readonly concurrency: number
  readonly timeoutMs: number
}

export interface Calibration<I, O, E, Ref, C extends { readonly id: string }, R, Shared> {
  readonly id: string
  /** Changes whenever gates, selection or thresholds change; part of the report identity. */
  readonly version: string
  readonly dataset: Dataset<I, Ref>
  /** Strict codec for candidates read from files. */
  readonly candidate: Schema.Codec<C>
  readonly candidates: ReadonlyArray<C>
  readonly subject: CalibrationSubject<I, O, E, C, R, Shared>
  readonly output: Schema.Codec<O>
  readonly evidence: Schema.Codec<E>
  readonly evaluators: ReadonlyArray<EvaluatorBinding<AssessmentInput<I, O, E, Ref>, R>>
  readonly gates: ReadonlyArray<AggregateGate>
  readonly judgeCalibration?: JudgeCalibration<Ref, O>
  /** The host's policy: candidate summaries ordered best first. The library never ranks on its own. */
  readonly select?: (summaries: ReadonlyArray<CandidateSummary<C>>) => ReadonlyArray<CandidateSummary<C>>
  readonly run: CalibrationRunDefaults
}

/** One run of a calibration; unset settings take the definition's defaults. */
export interface CalibrationRun {
  readonly runId: string
  readonly split: typeof EvaluationSplit.Type
  readonly repetitions?: number
  readonly concurrency?: number
  readonly timeoutMs?: number
}
