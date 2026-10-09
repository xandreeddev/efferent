import { expect, test } from "bun:test"
import { Effect, Layer, Option, Ref, Schema } from "effect"
import {
  EvalId,
  EvaluationError,
  EvaluationRunStore,
  gradingContext,
  fingerprint,
  runEvaluation,
  gradeEvaluation,
  executionFingerprint,
  validateEvaluationApp,
  reviewBundle,
  approveReviews,
  rankingMetrics,
  contextualPrecision,
  contextualRecall,
  type EvaluationApp,
  type Trial,
  type EvaluationRun
} from "../index.js"
import { unknownEvaluationUsage } from "../assessment.usecase.functions.js"

import { fixture, FixtureEnvironment } from "./fixture.testing.js"
import {
  EvaluationServicesLive,
  TrialExecution,
  EvidenceProjector,
  GraderAssessment
} from "../index.js"

const run = (app: EvaluationApp) =>
  runEvaluation(app, "run", { ids: ["suite"], split: "validation" }).pipe(
    Effect.provide(EvaluationServicesLive(app)),
    Effect.provide(
      Layer.succeed(EvaluationRunStore, {
        writeTrial: () => Effect.void,
        writeRun: () => Effect.void
      })
    )
  )

test("execution gets input alone; observed outcome and grades remain distinct", async () => {
  const app = fixture((input, candidate, world, recorder) =>
    Effect.gen(function* () {
      expect(input).toBe("question")
      expect(JSON.stringify({ input, candidate, world })).not.toContain(
        "secret-label"
      )
      yield* recorder.record("tool.completed", { result: "source" })
      return { output: "claimed", evidence: { facts: ["source"] } }
    })
  )
  const report = await Effect.runPromise(run(app))
  expect(report.trials[0]?.transcript[0]?.kind).toBe("tool.completed")
  expect(Option.getOrNull(report.trials[0]!.outcome)?.state).toEqual({
    state: "actual"
  })
  expect(report.gates[0]?.passed).toBe(true)
})

test("a failed execution preserves partial events and releases its environment", async () => {
  const released = await Effect.runPromise(Ref.make(0))
  const saved: Trial[] = []
  const configured = fixture((_, __, ___, recorder) => recorder.record("tool.started", { tool: "lookup" }).pipe(
    Effect.andThen(Effect.fail(new EvaluationError({ code: "execution", message: "failed" })))
  ), Layer.succeed(FixtureEnvironment, {
    open: () => Effect.acquireRelease(Effect.succeed({}), () => Ref.update(released, (count) => count + 1)),
    inspect: () => Effect.succeed({ state: { committed: false }, references: [] })
  }))
  const report = await Effect.runPromise(
    runEvaluation(configured, "run", { ids: [], split: "validation" }).pipe(
      Effect.provide(EvaluationServicesLive(configured)),
      Effect.provide(
        Layer.succeed(EvaluationRunStore, {
          writeTrial: (trial) =>
            Effect.sync(() => {
              saved.push(trial)
            }),
          writeRun: () => Effect.void
        })
      )
    )
  )
  expect(await Effect.runPromise(Ref.get(released))).toBe(1)
  expect(
    saved.some(
      (trial) => trial.status === "running" && trial.transcript.length === 1
    )
  ).toBe(true)
  expect(report.trials[0]?.status).toBe("error")
  expect(report.gates[0]?.value).toEqual(Option.none())
})

test("unavailable context emits no zero and cannot pass a gate", async () => {
  const app = fixture()
  const report = await Effect.runPromise(
    run({
      ...app,
      projections: [
        {
          ...app.projections[0]!,
          layer: Layer.effect(
            EvidenceProjector,
            Effect.fail(
              new EvaluationError({
                code: "unavailable",
                message: "missing source"
              })
            )
          )
        }
      ]
    })
  )
  expect(report.trials[0]?.grades[0]?.status).toBe("unavailable")
  expect(report.trials[0]?.grades[0]?.metrics).toEqual([])
  expect(report.gates[0]?.passed).toBe(false)
  expect(Option.isNone(report.gates[0]!.value)).toBe(true)
})

test("UTF-8 budget includes reserved rubric bytes and versions change the fingerprint", async () => {
  const options = {
    projection: "projection",
    version: "1",
    input: "éé",
    schema: Schema.String,
    budget: { maxBytes: 8, reservedBytes: 3 },
    references: [],
    omissions: []
  }
  expect(
    await Effect.runPromise(gradingContext(options).pipe(Effect.isFailure))
  ).toBe(true)
  const a = await Effect.runPromise(
    gradingContext({ ...options, budget: { maxBytes: 20, reservedBytes: 3 } })
  )
  const b = await Effect.runPromise(
    gradingContext({
      ...options,
      version: "2",
      budget: { maxBytes: 20, reservedBytes: 3 }
    })
  )
  expect(a.bytes).toBe(6)
  expect(a.fingerprint).not.toBe(b.fingerprint)
  expect(fingerprint({ b: 2, a: 1 })).toBe(fingerprint({ a: 1, b: 2 }))
})

test("reviews require explicit approval tied to the captured evidence", async () => {
  const report = await Effect.runPromise(run(fixture()))
  const bundle = reviewBundle(report)
  expect(
    (await Effect.runPromise(approveReviews(report, bundle))).items
  ).toEqual([])
  expect(
    await Effect.runPromise(
      approveReviews(report, {
        ...bundle,
        items: bundle.items.map((item) => ({ ...item, approved: true }))
      }).pipe(Effect.isFailure)
    )
  ).toBe(true)
})

test("retrieval duplicates keep their rank and unjudged precision is unavailable", () => {
  const metrics = rankingMetrics(["other", "a", "a"], { a: 3, b: 2 }, 3)
  expect(Option.getOrNull(metrics.recall)).toBe(0.5)
  expect(Option.getOrNull(metrics.mrr)).toBe(0.5)
  expect(Option.isNone(metrics.precision)).toBe(true)
  expect(metrics.duplicates).toBe(1)
  expect(contextualPrecision([false, true, true])).toBeCloseTo(
    (0.5 + 2 / 3) / 2
  )
  expect(Option.isNone(contextualRecall([]))).toBe(true)
})

test("invalid registry bindings are rejected before executing", async () => {
  const app = fixture()
  expect(
    await Effect.runPromise(
      validateEvaluationApp({ ...app, graders: [] }).pipe(Effect.isFailure)
    )
  ).toBe(true)
})

test("candidate selection only gates selected candidates", async () => {
  const app = fixture()
  const configured = {
    ...app,
    suites: app.suites.map((suite) => ({
      ...suite,
      candidates: [
        ...suite.candidates,
        { ...suite.candidates[0]!, id: EvalId.make("other") }
      ]
    }))
  }
  const report = await Effect.runPromise(
    runEvaluation(configured, "run", {
      ids: [],
      split: "validation",
      candidates: ["candidate"]
    }).pipe(
      Effect.provide(EvaluationServicesLive(configured)),
      Effect.provide(
        Layer.succeed(EvaluationRunStore, {
          writeTrial: () => Effect.void,
          writeRun: () => Effect.void
        })
      )
    )
  )
  expect(report.trials).toHaveLength(1)
  expect(report.gates).toHaveLength(1)
  expect(report.gates[0]?.passed).toBe(true)
})

test("all execution is captured before the first grader and can be graded repeatedly without reopening environments", async () => {
  const base = fixture()
  const calls = { executions: 0, opens: 0, grades: 0 }
  const snapshots: EvaluationRun[] = []
  const app: EvaluationApp = {
    ...base,
    runnables: base.runnables.map((registration) => ({
      ...registration,
      environments: registration.environments.map((environment) => ({
        ...environment,
        layer: Layer.effect(TrialExecution, Effect.gen(function* () {
          const execution = yield* TrialExecution
          return {
            execute: (...args: Parameters<typeof execution.execute>) => {
              calls.executions++
              calls.opens++
              return execution.execute(...args)
            }
          }
        })).pipe(Layer.provide(environment.layer))
      }))
    })),
    graders: base.graders.map((registration) => ({
      ...registration,
      layer: Layer.effect(
        GraderAssessment,
        Effect.gen(function* () {
          const grader = yield* GraderAssessment
          return {
            assess: (...args: Parameters<typeof grader.assess>) => {
              calls.grades++
              expect(snapshots[0]?.phase).toBe("executed")
              expect(
                snapshots[0]?.trials.every((trial) => trial.grades.length === 0)
              ).toBe(true)
              return grader.assess(...args)
            }
          }
        })
      ).pipe(Layer.provide(registration.layer))
    }))
  }
  const store = Layer.succeed(EvaluationRunStore, {
    writeTrial: () => Effect.void,
    writeRun: (run) =>
      Effect.sync(() => {
        snapshots.push(run)
      })
  })
  const executed = await Effect.runPromise(
    runEvaluation(app, "execution", {
      ids: ["suite"],
      split: "validation",
      executeOnly: true
    }).pipe(Effect.provide(EvaluationServicesLive(app)), Effect.provide(store))
  )
  expect(executed.phase).toBe("executed")
  expect(calls).toEqual({ executions: 1, opens: 1, grades: 0 })
  const original = JSON.stringify(executed)
  const first = await Effect.runPromise(
    gradeEvaluation(app, executed, "grade-one").pipe(
      Effect.provide(EvaluationServicesLive(app)),
      Effect.provide(store)
    )
  )
  const second = await Effect.runPromise(
    gradeEvaluation(app, executed, "grade-two").pipe(
      Effect.provide(EvaluationServicesLive(app)),
      Effect.provide(store)
    )
  )
  expect(calls).toEqual({ executions: 1, opens: 1, grades: 2 })
  expect(first.gates[0]?.passed).toBe(true)
  expect(second.fingerprints.sourceExecution).toBe(
    executionFingerprint(executed)
  )
  expect(first.trials[0]?.grades[0]?.context).toEqual(
    second.trials[0]?.grades[0]?.context.pipe(
      Option.map((context) => ({
        ...context,
        references: first.trials[0]!.grades[0]!.context.pipe(Option.getOrThrow)
          .references
      }))
    )
  )
  expect(JSON.stringify(executed)).toBe(original)
})

test("changed grader versions score the saved execution without a runnable or environment call", async () => {
  const base = fixture()
  const source = await Effect.runPromise(
    runEvaluation(base, "source", {
      ids: [],
      split: "validation",
      executeOnly: true
    }).pipe(
      Effect.provide(EvaluationServicesLive(base)),
      Effect.provide(
        Layer.succeed(EvaluationRunStore, {
          writeTrial: () => Effect.void,
          writeRun: () => Effect.void
        })
      )
    )
  )
  const changed: EvaluationApp = {
    ...base,
    runnables: base.runnables.map((runnable) => ({
      ...runnable,
      environments: runnable.environments.map((environment) => ({
        ...environment,
        layer: Layer.effect(TrialExecution, Effect.die("Execution must not be acquired during grading"))
      }))
    })),
    graders: base.graders.map((grader) => ({
      ...grader,
      definition: { ...grader.definition, version: "2" }
    })),
    suites: base.suites.map((suite) => ({
      ...suite,
      tasks: suite.tasks.map((task) => ({
        ...task,
        graders: task.graders.map((binding) => ({
          ...binding,
          grader: binding.grader.replace("@1", "@2")
        }))
      })),
      gates: suite.gates.map((gate) => ({
        ...gate,
        grader: gate.grader.replace("@1", "@2")
      }))
    }))
  }
  const report = await Effect.runPromise(
    gradeEvaluation(changed, source, "revision").pipe(
      Effect.provide(EvaluationServicesLive(changed)),
      Effect.provide(
        Layer.succeed(EvaluationRunStore, {
          writeTrial: () => Effect.void,
          writeRun: () => Effect.void
        })
      )
    )
  )
  expect(report.trials[0]?.grades[0]?.version).toBe("2")
  expect(report.gates[0]?.passed).toBe(true)
})
