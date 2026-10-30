import { expect, test } from "bun:test"
import { Effect, Layer, Option, Predicate, Schema } from "effect"
import {
  AssessmentError, EvalId, EvaluationError, EvaluationRun, EvaluationRunStore, EvaluationServicesLive, EvidenceProjector,
  GraderAssessment, SemanticJevLive, gradeEvaluation, gradingContext, graderFromEvaluator, runEvaluation, semanticEvaluator,
} from "../index.js"
import type { Evaluator, GraderRegistration, GradingContext, SemanticInput } from "../index.js"
import { fixture, spanRecorder } from "./fixture.testing.js"

// Only the writes these tests make; a store method they never reach dies if called.
const store = Layer.mock(EvaluationRunStore)({ writeTrial: () => Effect.void, writeRun: () => Effect.void })
const definition = { id: EvalId.make("grader"), version: "1", kind: "model" as const, metrics: ["correct"], fingerprints: { rubric: "rubric-v1" } }
const candidate = { id: EvalId.make("candidate"), configuration: {}, fingerprints: {} }
const budget = { maxBytes: 1000, reservedBytes: 0 }
const Answer = Schema.Struct({ answer: Schema.String })
const questions = {
  correct: { type: "boolean" as const, instructions: "The answer is supported by the evidence." },
  complete: { type: "score" as const, instructions: "The answer covers the question.", criteria: ["Missing", "Partial", "Complete"] },
}
const quality = semanticEvaluator({ id: "quality", version: "rubric-v1", questions, state: (input: typeof Answer.Type) => input.answer })

/** A Jev judge that answers every request with `answers` and keeps what it was asked. */
const scriptedJudge = (asked: Array<SemanticInput>) => SemanticJevLive({
  evaluate: async (request) => {
    asked.push(request)
    return { answers: { correct: { type: "boolean", probability: 0.9 }, complete: { type: "score", score: 2 } } }
  },
})

/** The fixture app graded by `grader`, its projection encoding the trial's output as an `Answer`, or `input` as it is. */
const appWith = (grader: GraderRegistration, input: Option.Option<unknown> = Option.none()) => ({
  ...fixture(),
  graders: [grader],
  projections: [{
    definition: { id: EvalId.make("projection"), version: "1", budget },
    layer: Layer.succeed(EvidenceProjector, {
      project: (trial) => Option.match(input, {
        onNone: () => gradingContext({ projection: "projection", version: "1", schema: Answer, budget, references: [trial.id], omissions: [],
          input: { answer: Option.match(trial.output, { onNone: () => "", onSome: (output) => Predicate.isString(output) ? output : "" }) } }),
        onSome: (value) => gradingContext({ projection: "projection", version: "1", schema: Schema.Unknown, input: value, budget, references: [trial.id], omissions: [] }),
      }),
    }),
  }],
})

const context = (input: unknown, references: ReadonlyArray<string> = []): GradingContext =>
  ({ projection: "projection", version: "1", input, references, omissions: [], bytes: 0, fingerprint: "context" })
/** One grade of `grader` over `grading`, straight through its port. */
const assessWith = (grader: GraderRegistration, grading: GradingContext) =>
  GraderAssessment.use((port) => port.assess(grading, candidate)).pipe(Effect.provide(grader.layer))
/** An evaluator of the grader's input that answers with `run`. */
const scripted = (run: Evaluator<typeof Answer.Type>["run"], metrics: ReadonlyArray<string> = ["correct", "complete"]): Evaluator<typeof Answer.Type> =>
  ({ id: "scripted", version: "1", metrics, run })
/** The one grade a run of the fixture app gives, `evaluator` behind its grader. */
const runGradeOf = (evaluator: Evaluator<typeof Answer.Type>) => {
  const app = appWith(graderFromEvaluator({ definition, input: Answer, evaluator }, Layer.empty))
  return runEvaluation(app, "run", { ids: ["suite"], split: "validation" }).pipe(
    Effect.provide(Layer.merge(EvaluationServicesLive(app), store)),
    Effect.map((report) => report.trials[0]!.grades[0]!),
  )
}

test("a semantic evaluator behind a grader grades a trial end to end, keeps the grader's metrics, and its report stores and reads back", async () => {
  const asked: Array<SemanticInput> = []
  const app = appWith(graderFromEvaluator({ definition, input: Answer, evaluator: quality }, scriptedJudge(asked)))
  const { tracer, named, parentOf } = spanRecorder()
  const report = await Effect.runPromise(runEvaluation(app, "run", { ids: ["suite"], split: "validation" }).pipe(
    Effect.provide(Layer.merge(EvaluationServicesLive(app), store)), Effect.withTracer(tracer),
  ))
  const grade = report.trials[0]!.grades[0]!
  expect(asked.map((request) => request.state)).toEqual(["answer"])
  expect([grade.grader, grade.version, grade.status, grade.reason]).toEqual(["grader", "1", "scored", "Structured rubric assessment"])
  expect(grade.metrics).toEqual([{ kind: "probability", name: "correct", value: 0.9 }])
  expect(grade.metadata.backend).toBe("jev")
  expect(named("eval.evaluator").map((span) => [parentOf(span), span.attributes.get("eval.evaluator.id"), span.attributes.get("eval.evaluator.version")]))
    .toEqual([["eval.grade", "quality", "rubric-v1"]])
  // As the file store writes and reads a report.
  const stored = await Effect.runPromise(Schema.encodeEffect(EvaluationRun)(report).pipe(
    Effect.flatMap((encoded) => Schema.decodeUnknownEffect(Schema.fromJsonString(EvaluationRun))(JSON.stringify(encoded))),
  ))
  expect(stored).toEqual(report)
})

test("saved work is regraded through the evaluator, without running the task again", async () => {
  const app = appWith(graderFromEvaluator({ definition, input: Answer, evaluator: quality }, scriptedJudge([])))
  const services = Layer.merge(EvaluationServicesLive(app), store)
  const saved = await Effect.runPromise(runEvaluation(app, "saved", { ids: ["suite"], split: "validation", executeOnly: true }).pipe(Effect.provide(services)))
  const regraded = await Effect.runPromise(gradeEvaluation(app, saved, "regraded").pipe(Effect.provide(services)))
  expect(saved.trials[0]!.grades).toEqual([])
  expect(regraded.trials[0]!.grades.map((grade) => [grade.status, grade.metrics])).toEqual([["scored", [{ kind: "probability", name: "correct", value: 0.9 }]]])
})

test("a grading context that does not decode as the evaluator's input is an invalid grade, and the judge is never asked", async () => {
  const asked: Array<SemanticInput> = []
  const app = appWith(graderFromEvaluator({ definition, input: Answer, evaluator: quality }, scriptedJudge(asked)), Option.some({ answer: 42 }))
  const report = await Effect.runPromise(runEvaluation(app, "run", { ids: ["suite"], split: "validation" }).pipe(Effect.provide(Layer.merge(EvaluationServicesLive(app), store))))
  const grade = report.trials[0]!.grades[0]!
  expect([grade.status, grade.metrics]).toEqual(["error", []])
  expect(grade.reason).toStartWith("invalid: Grading context does not decode as grader grader@1's input: ")
  expect(asked).toEqual([])
})

test("an AssessmentError becomes the EvaluationError of the same code, message and cause; an EvaluationError passes as it is", async () => {
  const cause = new Error("rate limited")
  const unavailable = await Effect.runPromise(assessWith(
    graderFromEvaluator({ definition, input: Answer, evaluator: scripted(() => Effect.fail(new AssessmentError({ code: "unavailable", message: "judge busy", cause }))) }, Layer.empty),
    context({ answer: "a" }),
  ).pipe(Effect.flip))
  expect([unavailable._tag, unavailable.code, unavailable.message, unavailable.cause]).toEqual(["EvaluationError", "unavailable", "judge busy", cause])
  const own = new EvaluationError({ code: "budget", message: "over budget" })
  expect(await Effect.runPromise(assessWith(graderFromEvaluator({ definition, input: Answer, evaluator: scripted(() => Effect.fail(own)) }, Layer.empty), context({ answer: "a" })).pipe(Effect.flip))).toBe(own)
})

test("an unavailable evaluator is an unavailable grade, never a measured zero; a crashed one is an error named by its message, never a stack frame or a path", async () => {
  // Made here, so its stack names this file.
  const crashed = new Error("judge crashed")
  const unavailable = await Effect.runPromise(runGradeOf(scripted(() => Effect.fail(new AssessmentError({ code: "unavailable", message: "missing evidence" })))))
  const died = await Effect.runPromise(runGradeOf(scripted(() => Effect.die(crashed))))
  expect([unavailable.status, unavailable.metrics, unavailable.reason, Option.isNone(unavailable.usage.costUsd)]).toEqual(["unavailable", [], "unavailable: missing evidence", true])
  expect([died.status, died.metrics, died.reason]).toEqual(["error", [], "judge crashed"])
  expect(JSON.stringify([unavailable, died])).not.toContain(import.meta.dir)
})

test("references go to the grade's metadata; metrics outside the evaluator's declaration, or out of range, are invalid; a slow evaluator times out", async () => {
  const correct = { kind: "boolean" as const, name: "correct", value: true }
  const complete = { kind: "score" as const, name: "complete", value: 1, min: 0, max: 2 }
  const grade = await Effect.runPromise(assessWith(
    graderFromEvaluator({ definition, input: Answer, evaluator: scripted(() => Effect.succeed({ metrics: [correct, complete], reason: "checked", references: ["doc-1"], metadata: { judge: "scripted" } })) }, Layer.empty),
    context({ answer: "a" }),
  ))
  expect(grade).toEqual({ status: "scored", metrics: [correct], reason: "checked", usage: { inputTokens: Option.none(), outputTokens: Option.none(), costUsd: Option.none() }, metadata: { judge: "scripted", references: ["doc-1"] } })
  const unreferenced = await Effect.runPromise(assessWith(graderFromEvaluator({ definition, input: Answer, evaluator: scripted(() => Effect.succeed({ metrics: [correct, complete], reason: "checked", references: [] })) }, Layer.empty), context({ answer: "a" })))
  expect(unreferenced.metadata).toEqual({})
  const failures = await Effect.runPromise(Effect.all([
    scripted(() => Effect.succeed({ metrics: [correct], reason: "one missing" })),
    scripted(() => Effect.succeed({ metrics: [correct, { ...complete, value: 7 }], reason: "clamped" })),
  ].map((evaluator) => assessWith(graderFromEvaluator({ definition, input: Answer, evaluator }, Layer.empty), context({ answer: "a" })).pipe(Effect.flip)), { concurrency: 1 }))
  expect(failures.map((error) => error.code)).toEqual(["invalid", "invalid"])
  const late = await Effect.runPromise(assessWith(graderFromEvaluator({ definition, input: Answer, evaluator: scripted(() => Effect.never), timeoutMs: 5 }, Layer.empty), context({ answer: "a" })).pipe(Effect.flip))
  expect([late.code, late.message]).toEqual(["timeout", "Evaluator exceeded its deadline"])
})

test("the layer fails invalid when the evaluator does not declare a grader metric or the deadline is not positive, and a judge layer's AssessmentError keeps its code", async () => {
  const build = (grader: GraderRegistration) => Effect.runPromise(Effect.scoped(Layer.build(grader.layer)).pipe(Effect.flip))
  const undeclared = await build(graderFromEvaluator({ definition: { ...definition, metrics: ["correct", "fluent"] }, input: Answer, evaluator: quality }, scriptedJudge([])))
  expect([undeclared.code, undeclared.message]).toEqual(["invalid", "Grader grader@1 measures fluent, which evaluator quality@rubric-v1 does not declare"])
  expect((await build(graderFromEvaluator({ definition, input: Answer, evaluator: quality, timeoutMs: 0 }, scriptedJudge([])))).code).toBe("invalid")
  const judge = await build(graderFromEvaluator({ definition, input: Answer, evaluator: quality }, SemanticJevLive({ evaluate: async () => ({ answers: {} }), timeoutMs: -1 })))
  expect([judge._tag, judge.code, judge.message]).toEqual(["EvaluationError", "invalid", "Jev input limit and deadline must be positive"])
})
