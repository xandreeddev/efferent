import { runnableExecutionPort } from "../ports/runnable-execution.port.js"
import { TrialRecorder } from "../ports/trial-recorder.port.js"
import { evaluationEnvironmentPort } from "../ports/evaluation-environment.port.js"
import { EvidenceProjector } from "../ports/evidence-projector.port.js"
import { GraderAssessment } from "../ports/grader-assessment.port.js"
import { Effect, Option, Schema, Layer } from "effect"
import { EvalId, defineRunnable, gradingContext, type EvaluationApp } from "../index.js"
import { unknownEvaluationUsage } from "../assessment.usecase.functions.js"

export const FixtureWorld = Schema.Struct({ state: Schema.optionalKey(Schema.String) })
export const FixtureRunnable = runnableExecutionPort<string, Schema.Json, Schema.Json, typeof FixtureWorld.Type>("fixture")
export const FixtureEnvironment = evaluationEnvironmentPort<string, typeof FixtureWorld.Type>("fixture")
export const fixtureEnvironmentLive = Layer.succeed(FixtureEnvironment, {
  open: () => Effect.succeed({ state: "actual" }),
  inspect: (world) => Effect.succeed({ state: world, references: [] })
})
export const fixtureRegistration = (
  layer: Layer.Layer<typeof FixtureRunnable.Identifier, import("../index.js").EvaluationError>,
  environment: Layer.Layer<typeof FixtureEnvironment.Identifier, import("../index.js").EvaluationError> = fixtureEnvironmentLive
) => defineRunnable({
  definition: { id: EvalId.make("subject"), version: "1", description: "fixture", fingerprints: {} },
  input: Schema.String, output: Schema.Json, evidence: Schema.Json,
  runnable: FixtureRunnable, environment: FixtureEnvironment, layer,
  environments: [{ id: "memory", layer: environment }]
})

export const fixture = (
  execute: (
    ...args: [
      ...Parameters<typeof FixtureRunnable.Service["execute"]>,
      TrialRecorder["Service"]
    ]
  ) => ReturnType<typeof FixtureRunnable.Service["execute"]> = () =>
    Effect.succeed({ output: "answer", evidence: { facts: ["source"] } })
,
  environment: Layer.Layer<typeof FixtureEnvironment.Identifier, import("../index.js").EvaluationError> = fixtureEnvironmentLive
): EvaluationApp => ({
  id: "fixture",
  fingerprints: {},
  commands: {},
  calibrations: [],
  suites: [
    {
      id: EvalId.make("suite"),
      version: "1",
      purpose: "regression",
      description: "fixture",
      repetitions: 1,
      concurrency: 1,
      timeoutMs: 1000,
      tasks: [
        {
          id: EvalId.make("task"),
          version: "1",
          runnable: "subject",
          dataset: "dataset",
          datasetVersion: "1",
          family: "family",
          split: "validation",
          review: "reviewed",
          input: "question",
          reference: "secret-label",
          graders: [
            { grader: "grader@1", projection: "projection", scope: "trial" }
          ],
          provenance: "fixture"
        }
      ],
      candidates: [
        { id: EvalId.make("candidate"), configuration: {}, fingerprints: {} }
      ],
      gates: [
        {
          grader: "grader@1",
          metric: "correct",
          aggregate: "mean",
          mode: "blocking",
          minimum: Option.some(1),
          maximum: Option.none(),
          requiresReviewedReference: true
        }
      ]
    }
  ],
  runnables: [fixtureRegistration(Layer.succeed(FixtureRunnable, {
    execute: (input, candidate, environment) => Effect.gen(function* () {
      const recorder = yield* TrialRecorder
      return yield* execute(input, candidate, environment, recorder)
    })
  }), environment)],
  environmentFor: { subject: "memory" },
  projections: [
    {
      definition: {
        id: EvalId.make("projection"),
        version: "1",
        budget: { maxBytes: 100, reservedBytes: 10 }
      },
      layer: Layer.succeed(EvidenceProjector, {
        project: (trial) =>
          gradingContext({
            projection: "projection",
            version: "1",
            input: Option.getOrNull(trial.output),
            schema: Schema.Unknown,
            budget: { maxBytes: 100, reservedBytes: 10 },
            references: [trial.id],
            omissions: []
          })
      })
    }
  ],
  graders: [
    {
      definition: {
        id: EvalId.make("grader"),
        version: "1",
        kind: "code",
        metrics: ["correct"],
        fingerprints: {}
      },
      layer: Layer.succeed(GraderAssessment, {
        assess: () =>
          Effect.succeed({
            status: "scored",
            metrics: [{ kind: "boolean", name: "correct", value: true }],
            reason: "matches",
            usage: unknownEvaluationUsage,
            metadata: {}
          })
      })
    }
  ]
})
