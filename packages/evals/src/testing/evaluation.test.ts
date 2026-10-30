import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Deferred, Effect, Fiber, Layer, Option, Ref, Result, Schema, Tracer } from "effect"
import {
  EvalId,
  EvalPath,
  EvaluationRun,
  Gate,
  comparisonIssues,
  runGates,
  EvaluationError,
  EvaluationRunStore,
  gradingContext,
  fingerprint,
  runEvaluation,
  gradeEvaluation,
  executionFingerprint,
  parseEvaluationApp,
  evaluationAppViolations,
  reviewBundle,
  approveReviews,
  rankingMetrics,
  contextualPrecision,
  contextualRecall,
  type EvaluationApp,
  type TranscriptEvent,
  type Trial
} from "../index.js"
import { unknownEvaluationUsage } from "../assessment.usecase.functions.js"

import { fixture, FixtureEnvironment, spanRecorder } from "./fixture.testing.js"
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
        appendTranscript: () => Effect.void,
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
  const writes: string[] = []
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
              writes.push(`trial ${trial.status} ${trial.transcript.length}`)
            }),
          appendTranscript: (trial, event) =>
            Effect.sync(() => {
              writes.push(`event ${trial}#${event.sequence} ${event.kind}`)
            }),
          writeRun: () => Effect.void
        })
      )
    )
  )
  expect(await Effect.runPromise(Ref.get(released))).toBe(1)
  // The event is stored while the trial runs; the settled trial and its graded copy hold it.
  expect(writes).toEqual([
    "trial running 0",
    "event run/suite/candidate/task/1#0 tool.started",
    "trial error 1",
    "trial error 1"
  ])
  expect(report.trials[0]?.status).toBe("error")
  expect(report.gates[0]?.value).toEqual(Option.none())
})

test("each transcript event is appended in order, and the trial is written only when it starts, settles and is graded", async () => {
  const writes = { trials: 0 }
  const appended: TranscriptEvent[] = []
  // Ten records at a time: the writer still numbers and stores them one by one.
  const app = fixture((_, __, ___, recorder) =>
    Effect.forEach(
      Array.from({ length: 100 }, (_, index) => index),
      (index) => recorder.record("tool.completed", { index }),
      { concurrency: 10, discard: true }
    ).pipe(Effect.as({ output: "answer", evidence: { facts: ["source"] } }))
  )
  const report = await Effect.runPromise(
    runEvaluation(app, "run", { ids: [], split: "validation" }).pipe(
      Effect.provide(EvaluationServicesLive(app)),
      Effect.provide(
        Layer.succeed(EvaluationRunStore, {
          writeTrial: () => Effect.sync(() => { writes.trials++ }),
          appendTranscript: (_, event) => Effect.sync(() => { appended.push(event) }),
          writeRun: () => Effect.void
        })
      )
    )
  )
  expect(appended.map((event) => event.sequence)).toEqual(Array.from({ length: 100 }, (_, index) => index))
  expect(writes.trials).toBe(3)
  expect(report.trials[0]?.transcript).toEqual(appended)
})

test("a failed trial or grade keeps its error's code and message as its reason, never a stack frame or a path", async () => {
  // Made here, so their stacks name this file.
  const crashed = new Error("disk on fire")
  const judged = new Error("judge crashed")
  const died = await Effect.runPromise(run(fixture(() => Effect.die(crashed))))
  const failed = await Effect.runPromise(run(fixture(() => Effect.fail(new EvaluationError({ code: "execution", message: "the target refused" })))))
  const app = fixture()
  const graded = await Effect.runPromise(run({
    ...app,
    graders: [{ ...app.graders[0]!, layer: Layer.succeed(GraderAssessment, { assess: () => Effect.die(judged) }) }]
  }))
  expect([died.trials[0]?.status, died.trials[0]?.reason]).toEqual(["error", "disk on fire"])
  expect([failed.trials[0]?.status, failed.trials[0]?.reason]).toEqual(["error", "execution: the target refused"])
  expect([graded.trials[0]?.grades[0]?.status, graded.trials[0]?.grades[0]?.reason]).toEqual(["error", "judge crashed"])
  expect(JSON.stringify([died, failed, graded])).not.toContain(import.meta.dir)
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
  const refused = await Effect.runPromise(run({ ...app, graders: [] }).pipe(Effect.flip))
  expect(refused.code).toBe("invalid")
  expect(refused.violations?.map((entry) => [entry.rule, entry.path])).toEqual([
    ["grader-unknown", ["suites", 0, "tasks", 0, "graders", 0, "grader"]],
    ["grader-unknown", ["suites", 0, "gates", 0, "grader"]]
  ])
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
          appendTranscript: () => Effect.void,
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
    appendTranscript: () => Effect.void,
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
          appendTranscript: () => Effect.void,
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
          appendTranscript: () => Effect.void,
          writeRun: () => Effect.void
        })
      )
    )
  )
  expect(report.trials[0]?.grades[0]?.version).toBe("2")
  expect(report.gates[0]?.passed).toBe(true)
})

test("a timed-out or cancelled execution keeps the outcome its environment showed", async () => {
  const observed = Layer.succeed(FixtureEnvironment, {
    open: () => Effect.succeed({ state: "half-written" }),
    inspect: (world) => Effect.succeed({ state: world, references: [] })
  })
  const hanging = fixture(() => Effect.never, observed)
  const timedOut = await Effect.runPromise(run({
    ...hanging,
    suites: hanging.suites.map((suite) => ({ ...suite, timeoutMs: 20 }))
  }))
  expect([timedOut.trials[0]?.status, timedOut.trials[0]?.reason]).toEqual(["error", "timeout: Trial deadline exceeded"])
  expect(Option.getOrNull(timedOut.trials[0]!.outcome)?.state).toEqual({ state: "half-written" })
  const saved: Trial[] = []
  await Effect.runPromise(Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const app = fixture(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)), observed)
    const running = yield* runEvaluation(app, "run", { ids: [], split: "validation" }).pipe(
      Effect.provide(EvaluationServicesLive(app)),
      Effect.provide(Layer.succeed(EvaluationRunStore, {
        writeTrial: (trial) => Effect.sync(() => {
          saved.push(trial)
        }),
        appendTranscript: () => Effect.void,
        writeRun: () => Effect.void
      })),
      Effect.forkChild
    )
    yield* Deferred.await(started)
    yield* Fiber.interrupt(running)
  }))
  expect([saved.at(-1)?.status, saved.at(-1)?.reason]).toEqual(["cancelled", "interrupted"])
  expect(Option.getOrNull(saved.at(-1)!.outcome)?.state).toEqual({ state: "half-written" })
})

test("comparisons ignore the order trials ran in and still see changed grader coverage", async () => {
  const report = await Effect.runPromise(run(fixture()))
  const first = report.trials[0]!
  const second: Trial = {
    ...first,
    id: EvalPath.make("run/suite/candidate/other/1"),
    task: { ...first.task, id: EvalId.make("other"), graders: first.task.graders.map((binding) => ({ ...binding, scope: "answer" })) },
    grades: first.grades.map((grade) => ({ ...grade, scope: "answer" }))
  }
  const baseline = { ...report, trials: [first, second] }
  expect(comparisonIssues(baseline, { ...report, trials: [second, first] })).toEqual([])
  const reprojected: Trial = {
    ...second,
    task: { ...second.task, graders: second.task.graders.map((binding) => ({ ...binding, projection: "other" })) }
  }
  expect(comparisonIssues(baseline, { ...report, trials: [reprojected, first] })).toEqual(["Grader or projection coverage differs"])
})

test("fingerprints order object keys by code unit, so every locale hashes alike", () => {
  const canonical = JSON.stringify({ B: 1, a: { C: 3, d: 2 } })
  expect(fingerprint({ a: { d: 2, C: 3 }, B: 1 })).toBe(createHash("sha256").update(canonical).digest("hex"))
})

test("ids are single segments, so trial files and grader keys cannot collide", async () => {
  expect(() => EvalId.make("suite/one")).toThrow()
  expect(() => EvalId.make("@acme/judge")).toThrow()
  expect(Schema.is(EvalPath)("run/suite/candidate/task/1")).toBe(true)
  expect(Schema.is(EvalPath)("run//task")).toBe(false)
  const report = await Effect.runPromise(run(fixture()))
  const encoded = Schema.encodeSync(EvaluationRun)(report)
  const decode = Schema.decodeUnknownResult(EvaluationRun)
  expect(Result.isSuccess(decode(encoded))).toBe(true)
  expect(Result.isFailure(decode({ ...encoded, trials: encoded.trials.map((trial) => ({ ...trial, suiteId: "a/b" })) }))).toBe(true)
  const app = fixture()
  const refused = await Effect.runPromise(
    runEvaluation(app, "nightly/1", { ids: [], split: "validation" }).pipe(
      Effect.provide(EvaluationServicesLive(app)),
      Effect.provide(Layer.succeed(EvaluationRunStore, { writeTrial: () => Effect.void, appendTranscript: () => Effect.void, writeRun: () => Effect.void })),
      Effect.flip
    )
  )
  expect(refused.code).toBe("invalid")
  expect(refused.message).toContain("nightly/1")
})

test("a grader is selected by its key or its id, and an unknown one is refused", async () => {
  const app = fixture()
  const store = Layer.succeed(EvaluationRunStore, { writeTrial: () => Effect.void, appendTranscript: () => Effect.void, writeRun: () => Effect.void })
  const executed = await Effect.runPromise(
    runEvaluation(app, "source", { ids: [], split: "validation", executeOnly: true }).pipe(
      Effect.provide(EvaluationServicesLive(app)), Effect.provide(store))
  )
  const regrade = (graders: ReadonlyArray<string>) => gradeEvaluation(app, executed, "revision", { graders }).pipe(
    Effect.provide(EvaluationServicesLive(app)), Effect.provide(store))
  expect((await Effect.runPromise(regrade(["grader"]))).trials[0]?.grades).toHaveLength(1)
  expect((await Effect.runPromise(regrade(["grader@1"]))).trials[0]?.grades).toHaveLength(1)
  expect((await Effect.runPromise(regrade(["judge"]).pipe(Effect.flip))).code).toBe("invalid")
})

test("a gate needs a bound, and a finding keeps its gate's mode", async () => {
  const app = fixture()
  const unbounded = {
    ...app,
    suites: app.suites.map((suite) => ({ ...suite, gates: suite.gates.map((gate) => ({ ...gate, minimum: Option.none<number>() })) }))
  }
  expect((await Effect.runPromise(parseEvaluationApp(unbounded).pipe(Effect.flip))).violations?.map((entry) => [entry.rule, entry.path])).toEqual([["shape", ["suites", 0, "gates", 0]]])
  const gate = { grader: "grader@1", metric: "correct", aggregate: "mean", mode: "blocking", requiresReviewedReference: true }
  expect(Result.isSuccess(Schema.decodeUnknownResult(Gate)({ ...gate, minimum: 1, maximum: null }))).toBe(true)
  expect(Result.isFailure(Schema.decodeUnknownResult(Gate)({ ...gate, minimum: null, maximum: null }))).toBe(true)
  const report = await Effect.runPromise(run(app))
  expect(runGates(unbounded.suites, report.trials).map((gate) => [gate.passed, gate.reason])).toEqual([[false, "Gate has no minimum or maximum"]])
  const encoded = Schema.encodeSync(EvaluationRun)(report)
  const decode = Schema.decodeUnknownResult(EvaluationRun)
  expect(Result.isFailure(decode({ ...encoded, gates: encoded.gates.map((gate) => ({ ...gate, mode: "Blocking" })) }))).toBe(true)
})

const breaks = (app: EvaluationApp) => evaluationAppViolations(app).map((entry) => [entry.rule, entry.path])
const refusedBy = async (value: unknown) =>
  (await Effect.runPromise(parseEvaluationApp(value).pipe(Effect.flip))).violations?.map((entry) => [entry.rule, entry.path])

test("each broken cross-reference names its rule and the path to the value", () => {
  const app = fixture()
  const suite = app.suites[0]!
  const task = suite.tasks[0]!
  const binding = task.graders[0]!
  const gate = suite.gates[0]!
  const grader = app.graders[0]!
  const withTask = (changes: Partial<typeof task>) => ({ ...app, suites: [{ ...suite, tasks: [{ ...task, ...changes }] }] })
  const withGate = (changes: Partial<typeof gate>) => ({ ...app, suites: [{ ...suite, gates: [{ ...gate, ...changes }] }] })
  const at = ["suites", 0, "tasks", 0]
  expect(breaks(app)).toEqual([])
  expect(breaks({ ...app, id: " " })).toEqual([["id-empty", ["id"]]])
  expect(breaks({ ...app, suites: [suite, suite] })).toEqual([["duplicate-id", ["suites", 1, "id"]]])
  expect(breaks({ ...app, suites: [{ ...suite, candidates: [] }] })).toEqual([["suite-empty", ["suites", 0, "candidates"]]])
  expect(breaks(withTask({ graders: [] }))).toEqual([["task-ungraded", [...at, "graders"]], ["gate-unbound", ["suites", 0, "gates", 0, "grader"]]])
  expect(breaks(withTask({ graders: [binding, binding] }))).toEqual([["binding-duplicate", [...at, "graders", 1]]])
  expect(breaks({ ...app, suites: [{ ...suite, tasks: [task, { ...task, id: EvalId.make("other"), split: "calibration" }] }] }))
    .toEqual([["split-mixed", [...at, "split"]], ["split-mixed", ["suites", 0, "tasks", 1, "split"]]])
  expect(breaks(withTask({ runnable: "absent" }))).toEqual([["runnable-unknown", [...at, "runnable"]]])
  expect(breaks({ ...app, environmentFor: { subject: "docker" } })).toEqual([["environment-unregistered", ["environmentFor", "subject"]]])
  expect(breaks({ ...app, environmentFor: {} })).toEqual([["environment-unregistered", ["environmentFor", "subject"]]])
  expect(breaks(withTask({ graders: [{ ...binding, grader: "grader@2" }] })))
    .toEqual([["grader-unknown", [...at, "graders", 0, "grader"]], ["gate-unbound", ["suites", 0, "gates", 0, "grader"]]])
  expect(breaks(withTask({ graders: [{ ...binding, projection: "absent" }] }))).toEqual([["projection-unknown", [...at, "graders", 0, "projection"]]])
  expect(breaks({ ...withGate({ grader: "other@1" }), graders: [grader, { ...grader, definition: { ...grader.definition, id: EvalId.make("other") } }] }))
    .toEqual([["gate-unbound", ["suites", 0, "gates", 0, "grader"]]])
  expect(breaks(withGate({ metric: "absent" }))).toEqual([["gate-metric-unknown", ["suites", 0, "gates", 0, "metric"]]])
  expect(breaks({ ...app, calibrations: [{ id: EvalId.make("calibration"), version: "1", grader: grader.definition, suite: { ...suite, candidates: [] } }] }))
    .toEqual([["duplicate-id", ["calibrations", 0, "suite", "id"]], ["suite-empty", ["calibrations", 0, "suite", "candidates"]]])
})

test("a value that is not an evaluation app is refused by shape, at the path of each issue", async () => {
  const app = fixture()
  expect(await refusedBy(42)).toEqual([["shape", []]])
  expect(await refusedBy({ ...app, commands: { estimate: "cost" }, graders: [{ ...app.graders[0]!, layer: {} }] }))
    .toEqual([["shape", ["graders", 0, "layer"]], ["shape", ["commands", "estimate"]]])
  expect(await refusedBy({ ...app, suites: [{ ...app.suites[0]!, id: "a/b" }] })).toEqual([["shape", ["suites", 0, "id"]]])
  const parsed = await Effect.runPromise(parseEvaluationApp(app))
  expect(parsed.suites).toEqual(app.suites)
  expect(parsed.graders[0]?.layer).toBe(app.graders[0]!.layer)
})

test("an app's observability layer is kept by decoding; anything else in its place is refused by shape", async () => {
  const observability = Layer.succeed(Tracer.Tracer, spanRecorder().tracer)
  const parsed = await Effect.runPromise(parseEvaluationApp({ ...fixture(), observability }))
  expect(parsed.observability).toBe(observability)
  expect(await refusedBy({ ...fixture(), observability: "otlp" })).toEqual([["shape", ["observability"]]])
})

test("a refusal keeps every violation and names the first five", async () => {
  const app = fixture()
  const suite = app.suites[0]!
  const refused = await Effect.runPromise(parseEvaluationApp({ ...app, suites: Array.from({ length: 7 }, () => suite) }).pipe(Effect.flip))
  expect(refused.code).toBe("invalid")
  expect(refused.violations).toHaveLength(6)
  expect(refused.message).toBe(
    `Evaluation app refused (6 violations): ${[1, 2, 3, 4, 5].map((index) => `duplicate-id at suites.${index}.id: suite id "suite" is used more than once`).join("; ")}; and 1 more`
  )
})
