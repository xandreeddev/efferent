import { expect, test } from "bun:test"
import { Effect, Layer, Option, Ref, Schema } from "effect"
import { ModelSpend, RunId } from "@xandreed/core"
import type { SpendCaps } from "@xandreed/core"
import {
  EvaluationError,
  EvaluationRun,
  EvaluationRunStore,
  EvaluationServicesLive,
  gradeEvaluation,
  runEvaluation,
  type EvaluationApp,
  type EvaluationSelection,
  type Trial
} from "../index.js"
import { fixture } from "./fixture.testing.js"

/**
 * A runnable whose one model send reserves `worst` in the trial's ledger
 * (for a turn, under `caps`), then settles at `cost`; a refused send fails
 * the trial.
 */
const spending = (worst: number, cost: number, caps: SpendCaps = {}) => fixture(() => Effect.gen(function* () {
  const ledger = yield* ModelSpend
  const hold = yield* ledger.reserve({ runId: RunId.make("turn"), amount: worst, caps })
  yield* ledger.settle(hold, cost)
  return { output: "answer", evidence: { facts: ["source"] } }
}).pipe(Effect.mapError((error) => new EvaluationError({ code: "provider", message: error.message, cause: error }))))

/** `app` run with `selection` (four samples of its one task by default) over a store that keeps what it is given. */
const runWith = (app: EvaluationApp, selection: Partial<EvaluationSelection> = {}) => Effect.gen(function* () {
  const written = yield* Ref.make<ReadonlyArray<Trial>>([])
  const store = Layer.succeed(EvaluationRunStore, {
    writeTrial: (trial) => Ref.update(written, (trials) => [...trials, trial]),
    appendTranscript: () => Effect.void,
    writeRun: () => Effect.void,
  })
  const run = yield* runEvaluation(app, "run", { ids: ["suite"], split: "validation", repetitions: 4, ...selection }).pipe(
    Effect.provide(Layer.merge(EvaluationServicesLive(app), store)),
  )
  const last = new Map((yield* Ref.get(written)).map((trial) => [trial.id, trial]))
  return { run, stored: [...last.values()] }
})

const summary = (trial: Trial) => ({ status: trial.status, spend: trial.spend, grades: trial.grades.length })

test("under its budget every trial runs, and the report records what each trial and the run settled", async () => {
  const { run } = await Effect.runPromise(runWith(spending(1, 0.75), { spendBudget: 10 }))
  expect(run.trials.map(summary)).toEqual(Array.from({ length: 4 }, () => ({ status: "completed", spend: { settled: 0.75 }, grades: 1 })))
  expect(run.spend).toEqual({ budget: Option.some(10), settled: 3 })
  expect(run.failures).toEqual([])
  expect(run.gates.map((gate) => gate.passed)).toEqual([true])
})

test("over its budget the run keeps its finished trials and skips the one the budget refused and the rest, never as failures", async () => {
  // Each send holds 1 and settles at 0.75: the third would hold 1.5 + 1, past 2.
  const { run, stored } = await Effect.runPromise(runWith(spending(1, 0.75), { spendBudget: 2 }))
  expect(run.trials.map(summary)).toEqual([
    { status: "completed", spend: { settled: 0.75 }, grades: 1 },
    { status: "completed", spend: { settled: 0.75 }, grades: 1 },
    { status: "skipped", spend: { settled: 0 }, grades: 0 },
    { status: "skipped", spend: undefined, grades: 0 },
  ])
  expect(run.trials[2]!.reason).toStartWith("budget: the total model spend cap of 2 would be passed: 1.5 is settled or held")
  expect(run.trials[3]!.reason).toStartWith("budget: not run: the total model spend cap of 2 would be passed")
  expect(run.trials[3]!.transcript).toEqual([])
  expect(run.spend).toEqual({ budget: Option.some(2), settled: 1.5 })
  expect(run.failures).toEqual([])
  // A gate over trials the budget skipped is not measured, so it does not pass.
  expect(run.gates.map((gate) => [gate.passed, gate.measured, gate.reason])).toEqual([[false, 2, "Incomplete trial or measurement coverage"]])
  // Every trial reaches the store, the ones not run too.
  expect(stored.map((trial) => trial.status)).toEqual(["completed", "completed", "skipped", "skipped"])
})

test("what the trials settled reaching the budget stops the run before its next trial", async () => {
  const { run } = await Effect.runPromise(runWith(spending(1, 1), { spendBudget: 2 }))
  expect(run.trials.map((trial) => trial.status)).toEqual(["completed", "completed", "skipped", "skipped"])
  expect(run.trials[2]!.reason).toBe("budget: not run: the run's spend budget of 2 is reached: 2 is settled")
  expect(run.spend).toEqual({ budget: Option.some(2), settled: 2 })
})

test("concurrent trials share one budget: what they hold together never passes it", async () => {
  const { run } = await Effect.runPromise(runWith(spending(1, 1), { spendBudget: 2.5, concurrency: 4, repetitions: 8 }))
  const completed = run.trials.filter((trial) => trial.status === "completed")
  expect(completed).toHaveLength(2)
  expect(run.trials.filter((trial) => trial.status === "skipped")).toHaveLength(6)
  expect(run.spend).toEqual({ budget: Option.some(2.5), settled: 2 })
  expect(run.failures).toEqual([])
})

test("a refusal under a turn's own cap fails that trial, and the run goes on", async () => {
  const { run } = await Effect.runPromise(runWith(spending(1, 1, { turn: 0.5 }), { spendBudget: 10, repetitions: 2 }))
  expect(run.trials.map((trial) => trial.status)).toEqual(["error", "error"])
  expect(run.failures).toHaveLength(2)
  expect(run.spend).toEqual({ budget: Option.some(10), settled: 0 })
})

test("without a budget a run records spend only once a trial reserves, and a run that metered nothing stores no spend key", async () => {
  const metered = await Effect.runPromise(runWith(spending(1, 0.5), { repetitions: 2 }))
  expect(metered.run.spend).toEqual({ budget: Option.none(), settled: 1 })
  expect(metered.run.trials.map((trial) => trial.spend)).toEqual([{ settled: 0.5 }, { settled: 0.5 }])
  const unmetered = await Effect.runPromise(runWith(fixture(), { repetitions: 2 }))
  const encoded = await Effect.runPromise(Schema.encodeEffect(Schema.fromJsonString(EvaluationRun))(unmetered.run))
  expect(unmetered.run.spend).toBeUndefined()
  expect(encoded).not.toContain("spend")
})

test("a run's spend and its skipped trials survive the report's JSON round trip, and a regrade leaves them as they were", async () => {
  const { run } = await Effect.runPromise(runWith(spending(1, 0.75), { spendBudget: 2 }))
  const text = await Effect.runPromise(Schema.encodeEffect(Schema.fromJsonString(EvaluationRun))(run))
  const encoded: { spend: unknown; trials: ReadonlyArray<{ spend?: unknown }> } = JSON.parse(text)
  expect(encoded.spend).toEqual({ budget: 2, settled: 1.5 })
  expect(encoded.trials.map((trial) => trial.spend)).toEqual([{ settled: 0.75 }, { settled: 0.75 }, { settled: 0 }, undefined])
  const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(Schema.fromJsonString(EvaluationRun))(text))
  expect(decoded).toEqual(run)
  const unbudgeted = await Effect.runPromise(Schema.encodeEffect(Schema.fromJsonString(EvaluationRun))({ ...run, spend: { budget: Option.none(), settled: 0 } }))
  expect(JSON.parse(unbudgeted).spend).toEqual({ budget: null, settled: 0 })

  const app = spending(1, 0.75)
  const regraded = await Effect.runPromise(gradeEvaluation(app, decoded, "regrade").pipe(
    Effect.provide(Layer.merge(EvaluationServicesLive(app), Layer.succeed(EvaluationRunStore, { writeTrial: () => Effect.void, appendTranscript: () => Effect.void, writeRun: () => Effect.void }))),
  ))
  expect(regraded.trials.map(summary)).toEqual(run.trials.map(summary))
  expect(regraded.spend).toEqual(run.spend)
  expect(regraded.failures).toEqual([])
})

test("a spend budget that is not positive and finite is refused before anything runs", async () => {
  const refusals = await Effect.runPromise(Effect.forEach([0, -1, Number.NaN, Number.POSITIVE_INFINITY], (spendBudget) =>
    Effect.flip(runWith(spending(1, 1), { spendBudget })).pipe(Effect.map((error) => [error.code, error.message])), { concurrency: 1 }))
  expect(refusals).toEqual(Array.from({ length: 4 }, () => ["invalid", "A spend budget must be positive and finite"]))
})
