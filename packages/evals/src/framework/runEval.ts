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

/** Sample standard deviation (n-1) of the per-sample means — 0 for < 2 samples. */
const sampleStdev = (ns: ReadonlyArray<number>): number => {
  if (ns.length < 2) return 0
  const m = average(ns)
  const variance = ns.reduce((a, x) => a + (x - m) ** 2, 0) / (ns.length - 1)
  return Math.sqrt(variance)
}

/** Average each scorer's score across the samples that produced it (failed
 *  samples contribute none). Keeps the last seen detail for context. */
const aggregateScores = (perSample: ReadonlyArray<ReadonlyArray<ScoreOutcome>>): Array<ScoreOutcome> => {
  const acc = new Map<string, { sum: number; n: number; detail?: string }>()
  for (const scores of perSample) {
    for (const s of scores) {
      const cur = acc.get(s.name) ?? { sum: 0, n: 0 }
      acc.set(s.name, { sum: cur.sum + s.score, n: cur.n + 1, ...(s.detail !== undefined ? { detail: s.detail } : {}) })
    }
  }
  return [...acc.entries()].map(([name, { sum, n, detail }]) =>
    detail !== undefined ? { name, score: sum / n, detail } : { name, score: sum / n },
  )
}

const firstLine = (s: string): string => s.split("\n")[0] ?? s

interface SampleResult {
  readonly ok: boolean
  readonly mean: number
  readonly scores: ReadonlyArray<ScoreOutcome>
  readonly error?: string
}

/** Did this one sample "pass"? Gated on the objective scorer when `spec.gate`
 *  is set (so pass^k reflects code correctness, not a noisy judge), else on the
 *  sample mean vs threshold. A crashed sample never passes. */
const samplePassed = <I, O, T, R>(spec: EvalSpec<I, O, T, R>, s: SampleResult): boolean => {
  if (!s.ok) return false
  if (spec.gate !== undefined) {
    const sc = s.scores.find((x) => x.name === spec.gate!.scorer)
    return sc !== undefined && sc.score >= (spec.gate.min ?? 1)
  }
  return s.mean >= (spec.threshold)
}

/** One sample of a case: run the task (exit-captured) then every scorer
 *  (exit-captured), collapsing to a per-sample mean. A task failure is a
 *  0-scored sample, never a crash. */
const runSample = <I, O, T, R>(
  spec: EvalSpec<I, O, T, R>,
  kase: EvalCase<I, T>,
): Effect.Effect<SampleResult, never, R> =>
  Effect.gen(function* () {
    const taskExit = yield* spec.task(kase.input, kase).pipe(Effect.withSpan("eval.task"), Effect.exit)
    if (Exit.isFailure(taskExit)) {
      return { ok: false, mean: 0, scores: [], error: Cause.pretty(taskExit.cause) }
    }
    const output = taskExit.value
    const scores: Array<ScoreOutcome> = []
    for (const scorer of spec.scorers) {
      const scoreExit = yield* scorer
        .score({ input: kase.input, output, expected: kase.expected })
        .pipe(Effect.withSpan(`eval.scorer:${scorer.name}`), Effect.exit)
      scores.push(
        Exit.isFailure(scoreExit)
          ? { name: scorer.name, score: 0, detail: `scorer error: ${firstLine(Cause.pretty(scoreExit.cause))}` }
          : toOutcome(scorer.name, scoreExit.value),
      )
    }
    return { ok: true, mean: average(scores.map((s) => s.score)), scores }
  })

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
    const n = Math.max(1, Math.floor(spec.samples ?? 1))
    // Samples run sequentially within a case (case-level concurrency already
    // parallelizes); the whole case stays ONE `eval.case` span.
    const samples = yield* Effect.forEach(Array.from({ length: n }, (_, i) => i), () =>
      runSample(spec, kase),
    )

    const means = samples.map((s) => s.mean)
    const mean = average(means)
    const stdev = sampleStdev(means)
    const anyOk = samples.some((s) => s.ok)
    // pass@k (any sample passed the gate) and pass^k (every sample did — the
    // consistency metric that matters for a write-to-disk agent).
    const passAtK = samples.some((s) => samplePassed(spec, s))
    const passHatK = samples.every((s) => samplePassed(spec, s))
    // Aggregate per-scorer over the samples that produced scores.
    const scores = aggregateScores(samples.filter((s) => s.ok).map((s) => s.scores))
    const error = anyOk ? undefined : samples.find((s) => s.error !== undefined)?.error

    const end = yield* Clock.currentTimeMillis
    yield* Effect.annotateCurrentSpan({
      "eval.ok": anyOk,
      "eval.samples": n,
      "eval.stdev": stdev,
      "eval.pass_at_k": passAtK,
      "eval.pass_hat_k": passHatK,
      ...scoreAttributes(scores, mean),
    })
    yield* Effect.forEach(scores, (s) => recordEvalScore(spec.name, s.name, s.score), {
      discard: true,
    })
    return {
      name: kase.name,
      ok: anyOk,
      ...(error !== undefined ? { error } : {}),
      scores,
      mean,
      samples: n,
      stdev,
      passAtK,
      passHatK,
      durationMs: end - start,
    }
  }).pipe(
    Effect.withSpan("eval.case", {
      attributes: {
        "eval.suite": spec.name,
        "eval.case": kase.name,
        ...(kase.tags !== undefined && kase.tags.length > 0
          ? { "eval.tags": kase.tags.join(",") }
          : {}),
        ...(kase.difficulty !== undefined ? { "eval.difficulty": kase.difficulty } : {}),
      },
    }),
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
    const threshold = spec.threshold

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
