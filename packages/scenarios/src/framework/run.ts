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
    { outcomes: [], stopped: false, detail: Option.none() } as StepFold,
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
              detail: Option.some(`step "${step.name}" act failed`),
            }),
          onSuccess: () =>
            runChecks(world, step).pipe(
              Effect.map((outcomes) => {
                const hardFail = outcomes.some((o) => o.severity === "hard" && !o.pass)
                return {
                  outcomes: [...state.outcomes, ...outcomes],
                  stopped: hardFail,
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
      checks: [],
      judges: [],
      score: 0,
      combined: 0,
      detail: `not supported in ${mode} mode`,
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
        status: "ran" as const,
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
        checks: [],
        judges: [],
        score: 0,
        combined: 0,
        detail: `boot/run crashed: ${String(cause).slice(0, 300)}`,
      }),
    ),
  )
}

/** Register a scenario in a pack: erases the world by pre-binding the runner. */
export const scenario = <W>(s: Scenario<W>): BoundScenario => ({
  name: s.name,
  modes: s.modes,
  run: (mode, judgeWeight) => runScenario(s, mode, judgeWeight),
})

export const runPack = (pack: Pack, mode: ScenarioMode): Effect.Effect<PackReport> =>
  Effect.gen(function* () {
    const judgeWeight = pack.judgeWeight ?? 0.3
    const scenarios = yield* Effect.forEach(pack.scenarios, (s) =>
      s.run(mode, judgeWeight),
    )
    const ran = scenarios.filter((s) => s.status === "ran")
    const errored = scenarios.some((s) => s.status === "error")
    const mean =
      ran.length === 0 ? 0 : ran.reduce((a, s) => a + s.combined, 0) / ran.length
    return {
      pack: pack.name,
      mode,
      scenarios,
      mean,
      threshold: pack.threshold,
      // An infra error is a failure (fail-closed); an all-skipped pack passes
      // vacuously (e.g. live-only pack under scripted mode).
      passed: !errored && (ran.length === 0 || mean >= pack.threshold),
    }
  })
