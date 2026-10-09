import { expect, test } from "bun:test"
import { Effect, Layer, Option, Ref } from "effect"
import {
  EvaluationServicesLive,
  EvaluationError,
  EvaluationRunStore,
  GraderAssessment,
  TrialRecorder,
  gradeEvaluation,
  runEvaluation,
  type Trial
} from "../index.js"
import { fixture, FixtureRunnable, FixtureEnvironment, fixtureRegistration } from "./fixture.testing.js"

const store = Layer.succeed(EvaluationRunStore, {
  writeTrial: () => Effect.void,
  writeRun: () => Effect.void
})

test("a late provider callback cannot change a settled trial or its durable transcript", async () => {
  const recorders: TrialRecorder["Service"][] = []
  const writes: Trial[] = []
  const app = fixture((_, __, ___, recorder) => Effect.gen(function* () {
    recorders.push(recorder)
    yield* recorder.record("model.request", { body: "exact request" })
    return { output: "answer", evidence: {} }
  }))
  const captured = await Effect.runPromise(runEvaluation(app, "late", {
    ids: [], split: "validation", executeOnly: true,
  }).pipe(Effect.provide(EvaluationServicesLive(app)), Effect.provide(Layer.succeed(EvaluationRunStore, {
    writeTrial: (trial) => Effect.sync(() => { writes.push(trial) }),
    writeRun: () => Effect.void,
  }))))
  const settled = JSON.stringify(writes.at(-1))
  const count = writes.length
  await Effect.runPromise(recorders[0]!.record("model.response", { body: "late cancelled response" }))
  expect(writes).toHaveLength(count)
  expect(JSON.stringify(writes.at(-1))).toBe(settled)
  expect(writes.at(-1)).toEqual(captured.trials[0])
  expect(captured.trials[0]?.status).toBe("completed")
  expect(captured.trials[0]?.transcript.map((event) => event.kind)).toEqual(["model.request"])
})

test("one reused runnable Layer creates independent services and recorders for concurrent trials", async () => {
  const resources = await Effect.runPromise(
    Ref.make({ acquired: 0, released: 0 })
  )
  const base = fixture()
  const layer = Layer.effect(
    FixtureRunnable,
      Effect.acquireRelease(
      Effect.gen(function* () {
        yield* Ref.update(resources, (counts) => ({
          ...counts,
          acquired: counts.acquired + 1
        }))
        const local = yield* Ref.make(0)
        return FixtureRunnable.of({
          execute: () =>
            Effect.gen(function* () {
              const recorder = yield* TrialRecorder
              const count = yield* Ref.updateAndGet(local, (value) => value + 1)
              yield* recorder.record("local.counter", { count })
              yield* Effect.sleep("5 millis")
              return { output: count, evidence: {} }
            })
        })
      }),
      () =>
        Ref.update(resources, (counts) => ({
          ...counts,
          released: counts.released + 1
        }))
    )
  )
  const app = {
    ...base,
    suites: base.suites.map((suite) => ({
      ...suite,
      repetitions: 4,
      concurrency: 4
    })),
    runnables: [fixtureRegistration(layer)]
  }
  const captured = await Effect.runPromise(
    runEvaluation(app, "parallel", {
      ids: [],
      split: "validation",
      executeOnly: true
    }).pipe(Effect.provide(EvaluationServicesLive(app)), Effect.provide(store))
  )
  expect(captured.trials).toHaveLength(4)
  expect(
    captured.trials.map((trial) => Option.getOrThrow(trial.output))
  ).toEqual([1, 1, 1, 1])
  expect(
    captured.trials.every(
      (trial) =>
        trial.transcript.length === 1 &&
        trial.transcript[0]?.data &&
        JSON.stringify(trial.transcript[0].data) === '{"count":1}'
    )
  ).toBe(true)
  expect(await Effect.runPromise(Ref.get(resources))).toEqual({
    acquired: 4,
    released: 4
  })
})

test("a trial timeout releases acquired environment services and preserves recorded work", async () => {
  const released = await Effect.runPromise(Ref.make(0))
  const environment = Layer.effect(
    FixtureEnvironment,
      Effect.acquireRelease(
      Effect.succeed(
        FixtureEnvironment.of({
          open: () => Effect.succeed({}),
          inspect: () => Effect.succeed({ state: {}, references: [] })
        })
      ),
      () => Ref.update(released, (count) => count + 1)
    )
  )
  const base = fixture((_, __, ___, recorder) =>
    recorder.record("task.started", {}).pipe(Effect.andThen(Effect.never))
  , environment)
  const app = {
    ...base,
    suites: base.suites.map((suite) => ({ ...suite, timeoutMs: 20 }))
  }
  const captured = await Effect.runPromise(
    runEvaluation(app, "timeout", {
      ids: [],
      split: "validation",
      executeOnly: true
    }).pipe(Effect.provide(EvaluationServicesLive(app)), Effect.provide(store))
  )
  expect(captured.trials[0]?.status).toBe("error")
  expect(captured.trials[0]?.transcript[0]?.kind).toBe("task.started")
  expect(await Effect.runPromise(Ref.get(released))).toBe(1)
})

test("a grading Layer failure releases resources and leaves saved execution untouched", async () => {
  const released = await Effect.runPromise(Ref.make(0))
  const base = fixture()
  const captured = await Effect.runPromise(
    runEvaluation(base, "source", {
      ids: [],
      split: "validation",
      executeOnly: true
    }).pipe(Effect.provide(EvaluationServicesLive(base)), Effect.provide(store))
  )
  const original = JSON.stringify(captured)
  const grader = Layer.effect(
    GraderAssessment,
    Effect.acquireRelease(
      Effect.succeed(
        GraderAssessment.of({
          assess: () =>
            Effect.fail(
              new EvaluationError({
                code: "provider",
                message: "judge unavailable"
              })
            )
        })
      ),
      () => Ref.update(released, (count) => count + 1)
    )
  )
  const app = { ...base, graders: [{ ...base.graders[0]!, layer: grader }] }
  const report = await Effect.runPromise(
    gradeEvaluation(app, captured, "revision").pipe(
      Effect.provide(EvaluationServicesLive(app)),
      Effect.provide(store)
    )
  )
  expect(report.trials[0]?.grades[0]?.status).toBe("error")
  expect(Option.getOrThrow(report.trials[0]!.output)).toBe("answer")
  expect(JSON.stringify(captured)).toBe(original)
  expect(await Effect.runPromise(Ref.get(released))).toBe(1)
})
