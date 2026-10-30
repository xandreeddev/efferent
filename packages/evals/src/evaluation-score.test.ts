import { expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { EvaluationRun } from "./domain/evaluation-run.entity.js"
import { ExportedScore } from "./evaluation-score.entity.js"
import { exportableScores } from "./evaluation-score.entity.functions.js"
import { EvaluationServicesLive } from "./adapters/evaluation-services.adapter.js"
import { EvaluationRunStore } from "./ports/evaluation-store.port.js"
import { runEvaluation } from "./usecases/run-evaluation.usecase.functions.js"
import { fixture } from "./testing/fixture.testing.js"

const encodedFixtureRun = () =>
  Effect.runPromise(
    runEvaluation(fixture(), "fixture-run", { ids: [], split: "validation" }).pipe(
      Effect.flatMap(Schema.encodeEffect(EvaluationRun)),
      Effect.provide(EvaluationServicesLive(fixture())),
      Effect.provide(Layer.succeed(EvaluationRunStore, { writeTrial: () => Effect.void, appendTranscript: () => Effect.void, writeRun: () => Effect.void }))
    )
  )

test("a score keeps the key and the remote-id seed every export so far derived", async () => {
  const run = await encodedFixtureRun()
  const grade = run.trials[0]!.grades[0]!
  expect(exportableScores(run)).toEqual([{
    trial: "fixture-run/suite/candidate/task/1",
    key: "grader@1/trial/correct",
    seed: "fixture-run/suite/candidate/task/1/grader/1/trial/correct",
    value: 1,
    comment: "matches",
    at: grade.endedAt,
    context: grade.context,
    usage: { inputTokens: null, outputTokens: null, costUsd: null }
  }])
  expect(grade.context).toMatchObject({ projection: "projection" })
})

test("only a scored grade's boolean, probability and score metrics are exported, a boolean as 0 or 1", async () => {
  const run = await encodedFixtureRun()
  const trial = run.trials[0]!
  const grade = trial.grades[0]!
  const metrics = [
    { kind: "boolean" as const, name: "flag", value: false },
    { kind: "probability" as const, name: "p", value: 0.25 },
    { kind: "score" as const, name: "s", value: 7, min: 0, max: 10 },
    { kind: "preference" as const, name: "pick", value: "A" as const }
  ]
  const scores = exportableScores({
    ...run,
    trials: [{
      ...trial,
      grades: [
        { ...grade, scope: "turn", metrics },
        ...(["error", "unavailable", "pending", "skipped"] as const).map((status) => ({ ...grade, status }))
      ]
    }]
  })
  expect(scores.map((score) => [score.key, score.seed, score.value])).toEqual([
    ["grader@1/turn/flag", `${trial.id}/grader/1/turn/flag`, 0],
    ["grader@1/turn/p", `${trial.id}/grader/1/turn/p`, 0.25],
    ["grader@1/turn/s", `${trial.id}/grader/1/turn/s`, 7]
  ])
  expect(scores.every(Schema.is(ExportedScore))).toBe(true)
})
