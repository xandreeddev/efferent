import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { EvaluationRunStore, EvaluationServicesLive, runEvaluation } from "@xandreed/evals"
import type { EvaluationRun } from "@xandreed/evals"
import { goldCases, recorded, reviewEvalApp } from "./review-eval.adapter.js"
import { goldScore, replayed, reviewKeyOf } from "./review-eval.entity.functions.js"

/** The replay suite run over a split, its results kept in memory. */
const runSplit = (split: string): Promise<EvaluationRun> => Effect.runPromise(Effect.gen(function* () {
  const app = yield* reviewEvalApp
  return yield* runEvaluation(app, "run", { ids: ["replay"], split }).pipe(
    Effect.provide(EvaluationServicesLive(app)),
    Effect.provide(Layer.succeed(EvaluationRunStore, { writeTrial: () => Effect.void, appendTranscript: () => Effect.void, writeRun: () => Effect.void })),
  )
}))

const DRAWS = ["haiku-5.5-high-d1", "haiku-5.5-high-d2"]

/** Per candidate, how many of the run's trials scored a metric true, of how many. */
const counts = (run: EvaluationRun, metric: string) => DRAWS.map((candidate) => {
  const trials = run.trials.filter((trial) => trial.candidate.id === candidate)
  const yes = trials.filter((trial) => trial.grades.some((grade) => grade.metrics.some((one) => one.name === metric && one.value === true)))
  return `${yes.length}/${trials.length}`
})

describe("the review eval's replay suite", () => {
  test("the known defects: 59, of which 27 tuning, 11 of #544 and 21 held out, which the suite does not run", async () => {
    const data = await Effect.runPromise(goldCases)
    const app = await Effect.runPromise(reviewEvalApp)
    const splits = ["tuning", "tuning-544", "held-out"].map((split) => data.cases.filter((gold) => gold.split === split).length)
    expect([data.cases.length, splits, app.suites[0]?.tasks.length]).toEqual([59, [27, 11, 21], 38])
  })

  test("on the tuning split: found 7/27 and 10/27 as the judge matched them, shown 4/27 and 7/27, every gate passed", async () => {
    const run = await runSplit("tuning")
    expect([counts(run, "found"), counts(run, "shown"), run.gates.map((gate) => [gate.candidate, gate.metric, gate.passed]), run.failures]).toEqual([
      ["7/27", "10/27"], ["4/27", "7/27"],
      [["haiku-5.5-high-d1", "found", true], ["haiku-5.5-high-d1", "shown", true], ["haiku-5.5-high-d2", "found", true], ["haiku-5.5-high-d2", "shown", true]],
      [],
    ])
  })

  test("on #544, reported apart: found 4/11 and 6/11, shown 2/11 and 3/11", async () => {
    const run = await runSplit("tuning-544")
    expect([counts(run, "found"), counts(run, "shown")]).toEqual([["4/11", "6/11"], ["2/11", "3/11"]])
  })

  test("the control: what is shown moves with the order, so the suite can fail on the reviewer's code", async () => {
    // Every finding made low leaves the report's order to path and line alone: the draws show other defects.
    const data = await Effect.runPromise(recorded)
    const golds = (await Effect.runPromise(goldCases)).cases.filter((gold) => gold.split === "tuning")
    const shownBy = (flatten: boolean) => data.draws.map((draw) => golds.filter((gold) => {
      const key = reviewKeyOf(gold)
      const findings = (draw.findings[key] ?? []).map((finding) => (flatten ? { ...finding, severity: "low" as const } : finding))
      return goldScore(replayed(findings, data.files[key] ?? []), gold.gold).shown
    }).length)
    const [kept, flattened] = [shownBy(false), shownBy(true)]
    expect(kept).toEqual([4, 7])
    expect(flattened).not.toEqual(kept)
  })
})
