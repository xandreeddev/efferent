import { Cause, Clock, Effect, Exit } from "effect"
import type {
  CaseResult,
  EvalCase,
  EvalReport,
  EvalSpec,
  ScoreOutcome,
  ScoreResult,
} from "./Eval.js"

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

const toOutcome = (name: string, r: ScoreResult): ScoreOutcome =>
  typeof r === "number"
    ? { name, score: clamp01(r) }
    : r.detail !== undefined
      ? { name, score: clamp01(r.score), detail: r.detail }
      : { name, score: clamp01(r.score) }

const average = (ns: ReadonlyArray<number>): number =>
  ns.length === 0 ? 0 : ns.reduce((a, b) => a + b, 0) / ns.length

const firstLine = (s: string): string => s.split("\n")[0] ?? s

/**
 * Run one case: the task and every scorer go through `Effect.exit`, so a
 * failure (a typed `AiError`, a 429 surfaced as a defect, a thrown scorer)
 * is *captured* as a 0-scored result instead of aborting the whole eval.
 */
const runCase = <I, O, T, R>(
  spec: EvalSpec<I, O, T, R>,
  kase: EvalCase<I, T>,
): Effect.Effect<CaseResult, never, R> =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeMillis
    const taskExit = yield* spec.task(kase.input, kase).pipe(Effect.exit)

    if (Exit.isFailure(taskExit)) {
      const end = yield* Clock.currentTimeMillis
      return {
        name: kase.name,
        ok: false,
        error: Cause.pretty(taskExit.cause),
        scores: [],
        mean: 0,
        durationMs: end - start,
      }
    }

    const output = taskExit.value
    const scores: Array<ScoreOutcome> = []
    for (const scorer of spec.scorers) {
      const scoreExit = yield* scorer
        .score({ input: kase.input, output, expected: kase.expected })
        .pipe(Effect.exit)
      scores.push(
        Exit.isFailure(scoreExit)
          ? {
              name: scorer.name,
              score: 0,
              detail: `scorer error: ${firstLine(Cause.pretty(scoreExit.cause))}`,
            }
          : toOutcome(scorer.name, scoreExit.value),
      )
    }

    const end = yield* Clock.currentTimeMillis
    return {
      name: kase.name,
      ok: true,
      scores,
      mean: average(scores.map((s) => s.score)),
      durationMs: end - start,
    }
  })

/**
 * Run a whole eval and collapse it into an `EvalReport`. Every per-case and
 * per-scorer failure is captured (via `Effect.exit`), so the result has no
 * error channel. The spec's environment `R` is left open — the caller provides
 * it once (so all suites share one set of clients / one `SettingsStore`).
 */
export const runEval = <I, O, T, R>(
  spec: EvalSpec<I, O, T, R>,
): Effect.Effect<EvalReport, never, R> =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeMillis
    const cases: ReadonlyArray<EvalCase<I, T>> = Array.isArray(spec.data)
      ? spec.data
      : yield* (
          spec.data as Effect.Effect<ReadonlyArray<EvalCase<I, T>>, unknown, R>
        ).pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<EvalCase<I, T>>)))

    const results = yield* Effect.forEach(cases, (kase) => runCase(spec, kase), {
      concurrency: spec.concurrency ?? 1,
    })

    const end = yield* Clock.currentTimeMillis
    const mean = average(results.map((r) => r.mean))
    const threshold = spec.threshold ?? 0.6

    return {
      name: spec.name,
      ...(spec.description !== undefined ? { description: spec.description } : {}),
      cases: results,
      mean,
      threshold,
      passed: mean >= threshold,
      durationMs: end - start,
    } satisfies EvalReport
  })
