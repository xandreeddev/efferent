import { Effect, Option } from "effect"
import type {
  BoundScenario,
  Check,
  CheckOutcome,
  JudgeOutcome,
  Pack,
  PackReport,
  Scenario,
  ScenarioMode,
  ScenarioResult,
  Step,
} from "./model.js"
import { wilsonInterval } from "./stats.js"

/**
 * The scenario runner: boot the world (scoped), fold the steps in order —
 * a failed HARD check marks the scenario failed and the remaining steps'
 * checks as failed (fail-closed) — then run judges (live mode) over the
 * finished world. Every act/boot failure is CAPTURED into the result
 * (the v2 `Effect.exit` discipline: a provider 429 scores 0, never crashes
 * the run).
 */

interface StepFold {
  readonly outcomes: ReadonlyArray<CheckOutcome>
  readonly stopped: boolean
  readonly crashed: boolean
  readonly detail: Option.Option<string>
}

const runChecks = <W>(
  world: W,
  step: Step<W>,
): Effect.Effect<ReadonlyArray<CheckOutcome>> =>
  Effect.forEach(step.checks, (check: Check<W>) =>
    check.run(world).pipe(
      Effect.map((result) => ({
        step: step.name,
        check: check.name,
        severity: check.severity,
        pass: result.pass,
        ...(result.detail !== undefined ? { detail: result.detail } : {}),
      })),
    ),
  )

const failedOutcomes = <W>(step: Step<W>, detail: string): ReadonlyArray<CheckOutcome> =>
  step.checks.map((check) => ({
    step: step.name,
    check: check.name,
    severity: check.severity,
    pass: false,
    detail,
  }))

const runSteps = <W>(world: W, steps: ReadonlyArray<Step<W>>): Effect.Effect<StepFold> =>
  Effect.reduce(
    steps,
    { outcomes: [], stopped: false, crashed: false, detail: Option.none() } as StepFold,
    (state, step) => {
      if (state.stopped) {
        return Effect.succeed({
          ...state,
          outcomes: [...state.outcomes, ...failedOutcomes(step, "skipped: an earlier hard check failed")],
        })
      }
      return step.act(world).pipe(
        Effect.matchEffect({
          onFailure: (cause) =>
            Effect.succeed({
              outcomes: [
                ...state.outcomes,
                ...failedOutcomes(step, `act failed: ${String(cause).slice(0, 300)}`),
              ],
              stopped: true,
              crashed: true,
              detail: Option.some(`step "${step.name}" act failed`),
            }),
          onSuccess: () =>
            runChecks(world, step).pipe(
              Effect.map((outcomes) => {
                const hardFail = outcomes.some((o) => o.severity === "hard" && !o.pass)
                return {
                  outcomes: [...state.outcomes, ...outcomes],
                  stopped: hardFail,
                  crashed: false,
                  detail: hardFail
                    ? Option.some(`hard check failed in step "${step.name}"`)
                    : state.detail,
                }
              }),
            ),
        }),
      )
    },
  )

const runJudges = <W>(
  world: W,
  judges: ReadonlyArray<{ readonly name: string; readonly run: (w: W) => Effect.Effect<{ readonly score: number; readonly reason: string }, unknown> }>,
): Effect.Effect<ReadonlyArray<JudgeOutcome>> =>
  Effect.forEach(judges, (judge) =>
    judge.run(world).pipe(
      Effect.map((verdict) => ({
        judge: judge.name,
        score: Math.max(0, Math.min(1, verdict.score)),
        reason: verdict.reason,
      })),
      Effect.catchAll((cause) =>
        Effect.succeed({ judge: judge.name, score: 0, reason: `judge failed: ${String(cause).slice(0, 200)}` }),
      ),
    ),
  )

export const runScenario = <W>(
  raw: Scenario<W>,
  mode: ScenarioMode,
  judgeWeight: number,
): Effect.Effect<ScenarioResult> => {
  if (!raw.modes.includes(mode)) {
    return Effect.succeed({
      name: raw.name,
      status: "skipped",
      hardPassed: false,
      checks: [],
      judges: [],
      score: 0,
      combined: 0,
      detail: `not supported in ${mode} mode`,
    })
  }
  if (raw.steps.length === 0 || raw.steps.some((step) => step.checks.length === 0)) {
    return Effect.succeed({
      name: raw.name,
      status: "error",
      hardPassed: false,
      checks: [],
      judges: [],
      score: 0,
      combined: 0,
      detail:
        raw.steps.length === 0
          ? "invalid scenario: no steps"
          : "invalid scenario: every step must declare at least one check",
    })
  }
  return Effect.scoped(
    Effect.gen(function* () {
      const world = yield* raw.boot
      const fold = yield* runSteps(world, raw.steps)
      const judges =
        mode === "live" && raw.judges !== undefined && !fold.stopped
          ? yield* runJudges(world, raw.judges)
          : []
      const evaluated = fold.outcomes.length
      const passed = fold.outcomes.filter((o) => o.pass).length
      const score = evaluated === 0 ? 0 : passed / evaluated
      const judgeMean =
        judges.length === 0
          ? Option.none<number>()
          : Option.some(judges.reduce((a, j) => a + j.score, 0) / judges.length)
      const combined = Option.match(judgeMean, {
        onNone: () => score,
        onSome: (jm) => score * (1 - judgeWeight) + jm * judgeWeight,
      })
      return {
        name: raw.name,
        status: fold.crashed ? ("error" as const) : ("ran" as const),
        hardPassed:
          !fold.stopped && fold.outcomes.every((o) => o.severity !== "hard" || o.pass),
        checks: fold.outcomes,
        judges,
        score,
        combined,
        ...Option.match(fold.detail, {
          onNone: () => ({}),
          onSome: (detail) => ({ detail }),
        }),
      }
    }),
  ).pipe(
    Effect.catchAllCause((cause) =>
      Effect.succeed({
        name: raw.name,
        status: "error" as const,
        hardPassed: false,
        checks: [],
        judges: [],
        score: 0,
        combined: 0,
        detail: `boot/run crashed: ${String(cause).slice(0, 300)}`,
      }),
    ),
  )
}

/** All-hard-checks-green — the pass@k pass criterion for one sample. */
const hardGreen = (result: ScenarioResult): boolean =>
  result.status === "ran" && result.hardPassed

/**
 * Run a scenario k times SEQUENTIALLY (each sample boots its own world) and
 * aggregate: `combined`/`score` become means over the samples, `passRate` is
 * the all-hard-green fraction, checks/judges shown are the LAST sample's.
 * A mode-skip is deterministic — returned as-is from the first sample. An
 * errored sample scores 0 and drags the mean (fail-closed), status stays
 * "ran" as long as any sample ran.
 */
const runSampled = <W>(
  raw: Scenario<W>,
  mode: ScenarioMode,
  judgeWeight: number,
  samples: number,
): Effect.Effect<ScenarioResult> =>
  Effect.forEach(Array.from({ length: samples }), () =>
    runScenario(raw, mode, judgeWeight),
  ).pipe(
    Effect.map((results) => {
      const first = results[0]
      if (first === undefined || first.status === "skipped") {
        return first ?? {
          name: raw.name,
          status: "error" as const,
          hardPassed: false,
          checks: [],
          judges: [],
          score: 0,
          combined: 0,
          detail: "no samples ran",
        }
      }
      const ran = results.filter((r) => r.status === "ran")
      const infraFailures = results.filter((r) => r.status === "error").length
      const last = ran[ran.length - 1] ?? first
      const scores = results.map((r) => r.combined)
      const mean = (xs: ReadonlyArray<number>) =>
        xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
      const passRate = results.filter(hardGreen).length / results.length
      const passRate95 = wilsonInterval(results.filter(hardGreen).length, results.length)
      return {
        ...last,
        status: infraFailures > 0 || ran.length === 0 ? ("error" as const) : ("ran" as const),
        hardPassed: infraFailures === 0 && results.every(hardGreen),
        score: mean(results.map((r) => r.score)),
        combined: mean(scores),
        ...(infraFailures > 0
          ? { detail: `${infraFailures}/${results.length} samples failed infrastructure` }
          : {}),
        samples: {
          count: results.length,
          scores: scores.map((s) => Number(s.toFixed(4))),
          passRate,
          passRate95,
          passAtK: 1 - Math.pow(1 - passRate, results.length),
          passAllK: Math.pow(passRate, results.length),
          infraFailures,
          outcomes: results.map(({ samples: _samples, ...result }) => result),
        },
      }
    }),
  )

/** Register a scenario in a pack: erases the world by pre-binding the runner.
 *  `samples` defaults to 1 — byte-identical to the unsampled runner. */
export const scenario = <W>(s: Scenario<W>): BoundScenario => ({
  name: s.name,
  modes: s.modes,
  run: (mode, judgeWeight, samples = 1) =>
    (samples <= 1 ? runScenario(s, mode, judgeWeight) : runSampled(s, mode, judgeWeight, samples)).pipe(
      Effect.tap((result) =>
        Effect.annotateCurrentSpan({
          "eval.case.status": result.status,
          "eval.case.hard_passed": result.hardPassed,
          "eval.case.score": result.combined,
        }),
      ),
      Effect.withSpan("eval.case", {
        attributes: { "eval.case.name": s.name, "eval.mode": mode, "eval.samples": samples },
      }),
    ),
})

export const runPack = (pack: Pack, mode: ScenarioMode): Effect.Effect<PackReport> =>
  Effect.gen(function* () {
    const judgeWeight = pack.judgeWeight ?? 0.3
    const scenarios = yield* Effect.forEach(pack.scenarios, (s) =>
      s.run(mode, judgeWeight, pack.samples ?? 1),
    )
    const ran = scenarios.filter((s) => s.status === "ran")
    const errored = scenarios.some((s) => s.status === "error")
    const hardFailed = ran.some((s) => !s.hardPassed)
    const mean =
      ran.length === 0 ? 0 : ran.reduce((a, s) => a + s.combined, 0) / ran.length
    return {
      pack: pack.name,
      mode,
      scenarios,
      mean,
      threshold: pack.threshold,
      // Infrastructure and hard checks are mandatory. An empty/all-skipped
      // pack is invalid: a battery that exercised nothing proves nothing.
      passed:
        pack.scenarios.length > 0 &&
        !errored &&
        !hardFailed &&
        ran.length > 0 &&
        mean >= pack.threshold,
    }
  }).pipe(
    Effect.tap((report) =>
      Effect.annotateCurrentSpan({
        "eval.mean": report.mean,
        "eval.threshold": report.threshold,
        "eval.passed": report.passed,
      }),
    ),
    Effect.withSpan("eval.run", {
      attributes: { "eval.pack": pack.name, "eval.mode": mode },
    }),
  )
