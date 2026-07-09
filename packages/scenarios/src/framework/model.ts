import type { Effect, Scope } from "effect"

/**
 * Evals v3 (docs/evals-v3.md) on the NEW LINE: the unit is a SCENARIO — an
 * ordered multi-step run over a booted WORLD — not a one-shot case. Steps
 * enforce order; checks are deterministic assertions over the world's
 * evidence AFTER each act; judges grade the finished world (live mode only).
 */

export interface CheckResult {
  readonly pass: boolean
  readonly detail?: string
}

export interface Check<W> {
  readonly name: string
  /** A failed HARD check stops the scenario (fail-closed, staged-gate style);
   *  a soft check records a finding and continues. */
  readonly severity: "hard" | "soft"
  /** Never throws/fails — a missing file/conversation is `{pass:false,detail}`. */
  readonly run: (world: W) => Effect.Effect<CheckResult>
}

export interface Step<W> {
  readonly name: string
  /** Drive the agent (send a turn, lock a spec, submit an answer). */
  readonly act: (world: W) => Effect.Effect<unknown, unknown>
  readonly checks: ReadonlyArray<Check<W>>
}

export interface Judge<W> {
  readonly name: string
  /** 0..1 with a reason — an anchored-rubric LLM judge over the finished world. */
  readonly run: (world: W) => Effect.Effect<{ readonly score: number; readonly reason: string }, unknown>
}

export type ScenarioMode = "scripted" | "live"

export interface Scenario<W> {
  readonly name: string
  readonly tags?: ReadonlyArray<string>
  /** Which modes this scenario supports. A scripted run skips live-only
   *  scenarios (and vice versa). */
  readonly modes: ReadonlyArray<ScenarioMode>
  /** Acquire the world — SCOPED (temp workspace, stores, event collectors
   *  release when the scenario finishes, steps included). */
  readonly boot: Effect.Effect<W, unknown, Scope.Scope>
  readonly steps: ReadonlyArray<Step<W>>
  readonly judges?: ReadonlyArray<Judge<W>>
}

export interface Pack {
  readonly name: string
  /** Suite pass bar for the deterministic score (0..1). */
  readonly threshold: number
  /** Judge weight when judges run (live mode); deterministic weight is the rest. */
  readonly judgeWeight?: number
  /** Samples per scenario (pass@k for stochastic prompts) — each scenario
   *  runs k times, its recorded score is the MEAN. Default 1 (today's
   *  behavior, byte-identical). */
  readonly samples?: number
  /** Baseline regression tolerance for THIS pack (live batteries are
   *  noisier). Default 0.05. */
  readonly tolerance?: number
  /** Provenance stamped into reports + minted baselines — prompt version
   *  constants ("judge-prompt": "1.0.0"), so a baseline delta is
   *  attributable to the prompt change that caused it. */
  readonly meta?: Record<string, string>
  /** Pack-level derived lines appended to the report (e.g. the calibration
   *  battery's false-block / false-pass rates). */
  readonly summary?: (report: PackReport) => ReadonlyArray<string>
  readonly scenarios: ReadonlyArray<BoundScenario>
}

/** A scenario with its world type erased by PRE-BINDING the runner — packs
 *  register these; the world stays pack-internal (no casts anywhere). */
export interface BoundScenario {
  readonly name: string
  readonly modes: ReadonlyArray<ScenarioMode>
  readonly run: (
    mode: ScenarioMode,
    judgeWeight: number,
    samples?: number,
  ) => Effect.Effect<ScenarioResult>
}

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

export interface CheckOutcome {
  readonly step: string
  readonly check: string
  readonly severity: "hard" | "soft"
  readonly pass: boolean
  readonly detail?: string
}

export interface JudgeOutcome {
  readonly judge: string
  readonly score: number
  readonly reason: string
}

export interface ScenarioResult {
  readonly name: string
  /** skipped = mode mismatch; error = boot/act infra failure. */
  readonly status: "ran" | "skipped" | "error"
  readonly checks: ReadonlyArray<CheckOutcome>
  readonly judges: ReadonlyArray<JudgeOutcome>
  /** Deterministic score: checks passed / checks evaluated (a hard fail marks
   *  the remaining steps' checks failed — fail-closed). */
  readonly score: number
  /** score folded with judge mean at the pack's judgeWeight (live mode).
   *  Under k>1 samples this is the MEAN of the per-sample combined scores. */
  readonly combined: number
  /** Present only when the scenario ran with k>1 samples: the per-sample
   *  combined scores and the fraction whose hard checks were ALL green.
   *  checks/judges above are the LAST sample's (for display). */
  readonly samples?: {
    readonly count: number
    readonly scores: ReadonlyArray<number>
    readonly passRate: number
  }
  readonly detail?: string
}

export interface PackReport {
  readonly pack: string
  readonly mode: ScenarioMode
  readonly scenarios: ReadonlyArray<ScenarioResult>
  /** Mean combined score over RAN scenarios. */
  readonly mean: number
  readonly threshold: number
  readonly passed: boolean
}
