import { Effect, Layer, Option, Ref, Schema } from "effect"
import type { DatasetCase } from "../assessment.usecase.js"
import { unknownEvaluationUsage } from "../assessment.usecase.functions.js"
import { CalibrationObservation, CalibrationReference } from "../domain/grader-calibration.entity.js"
import { calibrationAgreement } from "../domain/grader-calibration.entity.functions.js"
import { GradingContext } from "../domain/grading-context.entity.js"
import { gradingContext, fingerprint } from "../domain/grading-context.entity.functions.js"
import { EvalId, EvaluationError } from "../domain/identity.entity.js"
import { defineRunnable } from "./runnable.adapter.js"
import { runnableExecutionPort } from "../ports/runnable-execution.port.js"
import { evaluationEnvironmentPort } from "../ports/evaluation-environment.port.js"
import { TrialRecorder } from "../ports/trial-recorder.port.js"
import { EvidenceProjector } from "../ports/evidence-projector.port.js"
import { GraderAssessment } from "../ports/grader-assessment.port.js"
import type { Calibration } from "../domain/calibration.entity.js"
import type { Candidate } from "../domain/candidate.entity.js"
import type { GraderRegistration, ProjectionRegistration } from "../contracts/evaluation-app.contract.js"

/** Runs the registered grader as the subject; labels enter only the subsequent agreement grade. */
export const defineGraderCalibration = <I>(options: {
  readonly id: string
  readonly version: string
  readonly description: string
  readonly input: Schema.Codec<I, unknown>
  readonly cases: ReadonlyArray<DatasetCase<NoInfer<I>, CalibrationReference>>
  readonly grader: GraderRegistration
  readonly candidate?: Candidate
}) => {
  const id = options.id
  const subjectId = `${id}.subject`
  const agreementId = `${id}.agreement`
  const candidate: Candidate = options.candidate ?? {
    id: EvalId.make("registered-grader"), configuration: {},
    fingerprints: { grader: fingerprint(options.grader.definition) },
  }
  const Evidence = Schema.Struct({ context: GradingContext, observation: CalibrationObservation })
  type Evidence = typeof Evidence.Type
  type World = Ref.Ref<Option.Option<CalibrationObservation>>
  const runnablePort = runnableExecutionPort<I, CalibrationObservation, Evidence, World>(subjectId)
  const environmentPort = evaluationEnvironmentPort<I, World>(subjectId)
  const environmentId = `${subjectId}.in-process`
  const budget = { maxBytes: 1_048_576, reservedBytes: 0 }
  const decode = <A>(codec: Schema.Codec<A>, value: unknown) => Schema.decodeUnknownEffect(codec)(value).pipe(
    Effect.mapError((error) => new EvaluationError({ code: "invalid", message: String(error) })),
  )
  const runnable = defineRunnable({
    definition: { id: EvalId.make(subjectId), version: options.version, description: options.description,
      fingerprints: { grader: fingerprint(options.grader.definition) } },
    input: options.input, output: CalibrationObservation, evidence: Evidence,
    runnable: runnablePort, environment: environmentPort,
    environments: [{ id: environmentId, layer: Layer.succeed(environmentPort, {
      open: () => Ref.make(Option.none<CalibrationObservation>()),
      inspect: (world) => Ref.get(world).pipe(Effect.map((value) => ({ state: Option.getOrNull(value), references: [] }))),
    }) }],
    layer: Layer.succeed(runnablePort, {
      execute: (input, selected, world) => Effect.gen(function* () {
        const recorder = yield* TrialRecorder
        const context = yield* gradingContext({ projection: options.grader.definition.id, version: options.version,
          schema: options.input, input, budget, references: [], omissions: [] })
        yield* recorder.record("calibration.context", context)
        const result = yield* Effect.flatMap(GraderAssessment, (grader) => grader.assess(context, selected)).pipe(
          Effect.provide(Layer.fresh(options.grader.layer)), Effect.result,
        )
        const observation: CalibrationObservation = result._tag === "Success"
          ? { status: result.success.status, metrics: result.success.metrics, reason: result.success.reason }
          : { status: result.failure.code === "unavailable" ? "unavailable" : "error", metrics: [], reason: result.failure.message }
        yield* Ref.set(world, Option.some(observation))
        yield* recorder.record("calibration.observed", observation)
        return { output: observation, evidence: { context, observation } }
      }),
    }),
  })
  const AgreementInput = Schema.Struct({ observation: CalibrationObservation, reference: CalibrationReference })
  const projection: ProjectionRegistration = {
    definition: { id: EvalId.make(agreementId), version: options.version, budget },
    layer: Layer.succeed(EvidenceProjector, {
      project: (trial) => Effect.gen(function* () {
        const observation = yield* decode(CalibrationObservation, Option.getOrNull(trial.output))
        const reference = yield* decode(CalibrationReference, trial.task.reference)
        return yield* gradingContext({ projection: agreementId, version: options.version, schema: AgreementInput,
          input: { observation, reference }, budget, references: [trial.id],
          omissions: ["The grader's original context remains in execution evidence; agreement needs only its verdict and labels."] })
      }),
    }),
  }
  const grader: GraderRegistration = {
    definition: { id: EvalId.make(agreementId), version: options.version, kind: "code",
      metrics: ["agreement", "status-agreement", "metric-agreement", "false-pass", "false-fail"],
      fingerprints: { target: fingerprint(options.grader.definition), comparison: "calibration-agreement:1" } },
    layer: Layer.succeed(GraderAssessment, {
      assess: (context) => decode(AgreementInput, context.input).pipe(Effect.map(({ observation, reference }) => ({
        status: "scored" as const, metrics: calibrationAgreement(observation, reference, options.grader.definition.metrics),
        reason: observation.reason, usage: unknownEvaluationUsage, metadata: {},
      }))),
    }),
  }
  const calibration: Calibration = {
    id: EvalId.make(id), version: options.version, grader: options.grader.definition,
    suite: {
      id: EvalId.make(id), version: options.version, purpose: "regression", description: options.description,
      tasks: options.cases.map((item) => ({ ...item, id: EvalId.make(item.id), version: options.version,
        input: Schema.encodeSync(Schema.toCodecJson(options.input))(item.input),
        dataset: id, datasetVersion: options.version, runnable: subjectId,
        graders: [{ grader: `${agreementId}@${options.version}`, projection: agreementId, scope: "trial" }] })),
      candidates: [candidate],
      gates: ["agreement", "false-pass", "false-fail"].map((metric) => ({
        grader: `${agreementId}@${options.version}`, metric, aggregate: "mean" as const, mode: "blocking" as const,
        minimum: metric === "agreement" ? Option.some(1) : Option.none<number>(),
        maximum: metric === "agreement" ? Option.none<number>() : Option.some(0), requiresReviewedReference: true,
      })),
      repetitions: 1, concurrency: 1, timeoutMs: 30_000,
    },
  }
  return { calibration, runnable, graders: [grader], projections: [projection], environment: { id: environmentId } }
}
