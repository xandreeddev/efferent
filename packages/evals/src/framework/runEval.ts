import { Cause, Clock, Effect, Exit } from "effect"
import { recordEvalCase, recordEvalScore } from "../telemetry/metrics.js"
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
 * Quality attributes for a case span — the per-scorer scores under
 * `eval.score.*` plus the mean. The task self-annotates its own measurements
 * (tokens, steps, time) onto its `eval.task` span, so the trace carries
 * everything; this function only adds what the framework itself owns.
 */
const scoreAttributes = (
  scores: ReadonlyArray<ScoreOutcome>,
  mean: number,
): Record<string, number | boolean> => {
  const attrs: Record<string, number | boolean> = { "eval.mean": mean }
  for (const s of scores) attrs[`eval.score.${s.name}`] = s.score
  return attrs
}

/**
 * Run one case under an `eval.case` span: the task and every scorer go through
 * `Effect.exit`, so a failure (a typed `AiError`, a 429 surfaced as a defect, a
 * thrown scorer) is *captured* as a 0-scored result instead of aborting the
 * whole eval. Scores are annotated onto the span — the trace is the transparent
 * data channel a processing script reads.
 */
const runCase = <I, O, T, R>(
  spec: EvalSpec<I, O, T, R>,
  kase: EvalCase<I, T>,
): Effect.Effect<CaseResult, never, R> =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeMillis
    const taskExit = yield* spec
      .task(kase.input, kase)
      .pipe(Effect.withSpan("eval.task"), Effect.exit)

    if (Exit.isFailure(taskExit)) {
      const end = yield* Clock.currentTimeMillis
      yield* Effect.annotateCurrentSpan({ "eval.ok": false })
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
        .pipe(Effect.withSpan(`eval.scorer:${scorer.name}`), Effect.exit)
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
    const mean = average(scores.map((s) => s.score))
    yield* Effect.annotateCurrentSpan({ "eval.ok": true, ...scoreAttributes(scores, mean) })
    yield* Effect.forEach(scores, (s) => recordEvalScore(spec.name, s.name, s.score), {
      discard: true,
    })
    return {
      name: kase.name,
      ok: true,
      scores,
      mean,
      durationMs: end - start,
    }
  }).pipe(
    Effect.withSpan("eval.case", { attributes: { "eval.suite": spec.name, "eval.case": kase.name } }),
    Effect.annotateLogs({ "eval.suite": spec.name, "eval.case": kase.name }),
  )

/**
 * Run a whole eval and collapse it into an `EvalReport`. Every per-case and
 * per-scorer failure is captured (via `Effect.exit`), so the result has no
 * error channel. The spec's environment `R` is left open — the caller provides
 * it once (so all suites share one set of clients / one `SettingsStore`). The
 * suite runs under an `eval.suite` span so the exported trace is a tree:
 * suite → case → task / scorer.
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

    yield* Effect.forEach(results, (r) => recordEvalCase(spec.name, r.mean >= threshold), {
      discard: true,
    })
    yield* Effect.annotateCurrentSpan({
      "eval.suite": spec.name,
      "eval.mean": mean,
      "eval.passed": mean >= threshold,
      "eval.cases": results.length,
    })

    return {
      name: spec.name,
      ...(spec.description !== undefined ? { description: spec.description } : {}),
      cases: results,
      mean,
      threshold,
      passed: mean >= threshold,
      durationMs: end - start,
    } satisfies EvalReport
  }).pipe(Effect.withSpan("eval.suite", { attributes: { "eval.suite": spec.name } }))
