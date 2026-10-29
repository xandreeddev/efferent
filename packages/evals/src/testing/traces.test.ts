import { expect, test } from "bun:test"
import { Effect, Layer, Option, References } from "effect"
import {
  EvaluationRunStore,
  EvaluationServicesLive,
  gradeEvaluation,
  runEvaluation
} from "../index.js"
import { fixture, spanRecorder } from "./fixture.testing.js"

const store = Layer.succeed(EvaluationRunStore, {
  writeTrial: () => Effect.void,
  writeRun: () => Effect.void
})
const trialKeys = ["eval.run.id", "eval.trial.id", "eval.suite.id", "eval.task.id", "eval.candidate.id", "eval.sample"]

test("a run is one eval.run span: each trial under it, the grading under eval.regrade and each grade under that, all carrying the trial's ids", async () => {
  const { tracer, named, parentOf } = spanRecorder()
  const annotations: Array<Record<string, unknown>> = []
  const app = fixture(() =>
    Effect.gen(function* () {
      annotations.push(yield* References.CurrentLogAnnotations)
      return { output: "answer", evidence: { facts: ["source"] } }
    })
  )
  const report = await Effect.runPromise(
    runEvaluation(app, "run", { ids: ["suite"], split: "validation" }).pipe(
      Effect.provide(EvaluationServicesLive(app)),
      Effect.provide(store),
      Effect.withTracer(tracer)
    )
  )
  const ids = ["run", report.trials[0]!.id, "suite", "task", "candidate", 1]
  const [run] = named("eval.run")
  expect(named("eval.run")).toHaveLength(1)
  expect(run?.attributes.get("eval.run.id")).toBe("run")
  expect(Option.isNone(run!.parent)).toBe(true)
  expect(named("eval.trial").map(parentOf)).toEqual(["eval.run"])
  expect(named("eval.regrade").map(parentOf)).toEqual(["eval.run"])
  expect(named("eval.grade").map(parentOf)).toEqual(["eval.regrade"])
  expect(["eval.trial", "eval.grade"].map((name) => trialKeys.map((key) => named(name)[0]?.attributes.get(key)))).toEqual([ids, ids])
  // The runnable's logs carry the trial's ids as annotations, under the same keys.
  expect(annotations.map((each) => trialKeys.map((key) => each[key]))).toEqual([ids])
})

test("regrading saved work is one eval.regrade span over its grades, with no trial span", async () => {
  const app = fixture()
  const saved = await Effect.runPromise(
    runEvaluation(app, "saved", { ids: [], split: "validation", executeOnly: true }).pipe(
      Effect.provide(EvaluationServicesLive(app)),
      Effect.provide(store)
    )
  )
  const { tracer, named, parentOf } = spanRecorder()
  await Effect.runPromise(
    gradeEvaluation(app, saved, "regraded").pipe(
      Effect.provide(EvaluationServicesLive(app)),
      Effect.provide(store),
      Effect.withTracer(tracer)
    )
  )
  expect(named("eval.regrade").map((span) => span.attributes.get("eval.run.id"))).toEqual(["regraded"])
  expect(named("eval.grade").map((span) => [parentOf(span), span.attributes.get("eval.run.id")])).toEqual([["eval.regrade", "regraded"]])
  expect(named("eval.trial")).toHaveLength(0)
})
