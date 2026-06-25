import type { Effect } from "effect"

/**
 * A minimal, Effect-native eval library — the `data → task → scorers` shape
 * expressed as Effects so a `task` can be the real agent loop and a `Scorer` can
 * itself call an LLM. A spec is pure data; `runEval` turns it into an `Effect`.
 */

/** A scorer returns either a bare 0..1 number or a `{ score, detail }`. */
export interface ScoreValue {
  readonly score: number
  readonly detail?: string
}
export type ScoreResult = number | ScoreValue

export interface ScorerArgs<I, O, T> {
  readonly input: I
  readonly output: O
  readonly expected: T
}

/**
 * Judges one task output. `E`/`R` flow up into the spec, so a scorer that
 * calls `LanguageModel` (an LLM judge) just declares `R = LanguageModel`.
 */
export interface Scorer<I, O, T, E = never, R = never> {
  readonly name: string
  readonly score: (a: ScorerArgs<I, O, T>) => Effect.Effect<ScoreResult, E, R>
}

export interface EvalCase<I, T> {
  readonly name: string
  readonly input: I
  readonly expected: T
}

/**
 * A whole eval: a dataset, a task to run each input through, and scorers.
 * Pure data — the runtime environment `R` is supplied to `runEval` as a
 * `Layer`, not baked into the spec, so specs stay declarative.
 */
export interface EvalSpec<I, O, T, R> {
  readonly name: string
  readonly description?: string
  readonly data:
    | ReadonlyArray<EvalCase<I, T>>
    | Effect.Effect<ReadonlyArray<EvalCase<I, T>>, unknown, R>
  readonly task: (input: I, kase: EvalCase<I, T>) => Effect.Effect<O, unknown, R>
  readonly scorers: ReadonlyArray<Scorer<I, O, T, unknown, R>>
  /** Mean-score pass bar, 0..1. Default 0.6. */
  readonly threshold?: number
  /** How many cases run at once. Default 1 (gentle on rate limits). */
  readonly concurrency?: number
  /**
   * How many times to run EACH case (default 1). A single LLM run is noisy, so a
   * delta between two configs can be sampling noise; running N samples and
   * reporting mean ± stdev turns a number into a signal. The whole case still
   * collapses to ONE `eval.case` span (the aggregate mean), so the trace report
   * is unaffected; the framework `EvalReport` carries the variance.
   */
  readonly samples?: number
}

/** Identity helper that pins the generic inference at the definition site. */
export const defineEval = <I, O, T, R>(spec: EvalSpec<I, O, T, R>): EvalSpec<I, O, T, R> => spec

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

export interface ScoreOutcome {
  readonly name: string
  readonly score: number
  readonly detail?: string
}

export interface CaseResult {
  readonly name: string
  /** False when the task threw — captured, not propagated. */
  readonly ok: boolean
  readonly error?: string
  /** Per-scorer scores (averaged across samples when `samples > 1`). */
  readonly scores: ReadonlyArray<ScoreOutcome>
  /** Case mean (mean of per-sample means when sampled). */
  readonly mean: number
  /** How many samples produced this result (1 unless `spec.samples > 1`). */
  readonly samples?: number
  /** Sample stdev of the per-sample means — the noise on `mean`. 0 for 1 sample. */
  readonly stdev?: number
  readonly durationMs: number
}

export interface EvalReport {
  readonly name: string
  readonly description?: string
  readonly cases: ReadonlyArray<CaseResult>
  readonly mean: number
  readonly threshold: number
  readonly passed: boolean
  readonly durationMs: number
  /** Set when the suite declined to run (e.g. no provider key). */
  readonly skipped?: boolean
  readonly skipReason?: string
}
