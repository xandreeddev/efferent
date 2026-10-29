import {
  runnableExecutionPort,
  evaluationEnvironmentPort,
  defineRunnable,
  EvidenceProjector,
  GraderAssessment,
  EvalId,
  EvaluationError,
  unknownEvaluationUsage,
  gradingContext,
  type EvaluationApp
} from "@xandreed/evals"
import { Effect, Layer, Option, Schema } from "effect"

const FunctionRunnable = runnableExecutionPort<string, string, Schema.Json, Record<string, never>>("cli-fixture")
const FunctionEnvironment = evaluationEnvironmentPort<string, Record<string, never>>("cli-fixture")
/** One suite, one task and one candidate over an in-memory function; `execute` stands in for the function. */
export const cliFixture = (
  execute: (input: string) => Effect.Effect<{ readonly output: string; readonly evidence: Schema.Json }, EvaluationError> =
    (input) => Effect.succeed({ output: input, evidence: {} })
): EvaluationApp => ({
  id: "cli-fixture",
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
          id: EvalId.make("case"),
          version: "1",
          runnable: "function",
          dataset: "fixture",
          datasetVersion: "1",
          family: "fixture",
          split: "validation",
          review: "known",
          input: "hello",
          reference: "hello",
          provenance: "fixture",
          graders: [
            { grader: "contract@1", projection: "output", scope: "trial" }
          ]
        }
      ],
      candidates: [
        { id: EvalId.make("code"), configuration: {}, fingerprints: {} }
      ],
      gates: [
        {
          grader: "contract@1",
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
  runnables: [defineRunnable({
    definition: { id: EvalId.make("function"), version: "1", description: "identity", fingerprints: {} },
    input: Schema.String, output: Schema.String, evidence: Schema.Json,
    runnable: FunctionRunnable, environment: FunctionEnvironment,
    layer: Layer.succeed(FunctionRunnable, { execute }),
    environments: [{ id: "memory", layer: Layer.succeed(FunctionEnvironment, {
      open: () => Effect.succeed({}),
      inspect: () => Effect.succeed({ state: {}, references: [] })
    }) }]
  })],
  environmentFor: { function: "memory" },
  projections: [
    {
      definition: {
        id: EvalId.make("output"),
        version: "1",
        budget: { maxBytes: 100, reservedBytes: 0 }
      },
      layer: Layer.succeed(EvidenceProjector, {
        project: (trial) =>
          gradingContext({
            projection: "output",
            version: "1",
            input: Option.getOrNull(trial.output),
            schema: Schema.Unknown,
            budget: { maxBytes: 100, reservedBytes: 0 },
            references: [trial.id],
            omissions: []
          })
      })
    }
  ],
  graders: [
    {
      definition: {
        id: EvalId.make("contract"),
        version: "1",
        kind: "code",
        metrics: ["correct"],
        fingerprints: {}
      },
      layer: Layer.succeed(GraderAssessment, {
        assess: (context) =>
          Effect.succeed({
            status: "scored",
            metrics: [
              {
                kind: "boolean",
                name: "correct",
                value: context.input === "hello"
              }
            ],
            reason: "fixture",
            usage: unknownEvaluationUsage,
            metadata: {}
          })
      })
    }
  ]
})
