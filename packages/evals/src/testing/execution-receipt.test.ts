import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { ExecutionReceipt, EvaluationError, EvaluationRunStore, EvaluationServicesLive, runEvaluation } from "../index.js"
import { fixture, FixtureEnvironment } from "./fixture.testing.js"

const store = Layer.succeed(EvaluationRunStore, { writeTrial: () => Effect.void, writeRun: () => Effect.void })
test("execution receipts are recorded once per run after world opening, never for an unavailable world", async () => {
  const events: string[] = []
  const receipt = Layer.effect(ExecutionReceipt, Effect.gen(function* () {
    const recordOpened = yield* Effect.cached(Effect.sync(() => { events.push("receipt") }))
    return { recordOpened }
  }))
  const opened = fixture(() => Effect.sync(() => {
    events.push("subject")
    return { output: "answer", evidence: {} }
  }), Layer.succeed(FixtureEnvironment, {
    open: () => Effect.sync(() => { events.push("open"); return {} }),
    inspect: () => Effect.succeed({ state: {}, references: [] })
  }))
  const app = { ...opened, executionReceipt: receipt, suites: opened.suites.map((suite) => ({ ...suite, repetitions: 2 })) }
  const run = await Effect.runPromise(runEvaluation(app, "opened", { ids: [], split: "validation", executeOnly: true }).pipe(Effect.provide(EvaluationServicesLive(app)), Effect.provide(store)))
  expect(run.trials.every((trial) => trial.status === "completed")).toBe(true)
  expect(events).toEqual(["open", "receipt", "subject", "open", "subject"])
  events.splice(0)
  const unavailable = { ...fixture(undefined, Layer.succeed(FixtureEnvironment, {
    open: () => Effect.fail(new EvaluationError({ code: "unavailable", message: "World cannot open" })),
    inspect: () => Effect.succeed({ state: {}, references: [] })
  })), executionReceipt: receipt }
  const failed = await Effect.runPromise(runEvaluation(unavailable, "unavailable", { ids: [], split: "validation", executeOnly: true }).pipe(Effect.provide(EvaluationServicesLive(unavailable)), Effect.provide(store)))
  expect(failed.trials[0]?.status).toBe("error")
  expect(events).toEqual([])
})
