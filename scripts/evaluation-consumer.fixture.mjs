import {
  runnableExecutionPort,
  evaluationEnvironmentPort,
  TrialRecorder,
  EvidenceProjector,
  GraderAssessment
} from "@xandreed/evals"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Option, Schema, Layer } from "effect"
import {
  defineEvaluationApp,
  defineRunnable,
  EvalId,
  EvaluationRun,
  gradingContext,
  unknownEvaluationUsage
} from "@xandreed/evals"
import { evaluationCli } from "@xandreed/evals-cli"
import { langfuseExporter } from "@xandreed/evals-langfuse"
import { langsmithExporter } from "@xandreed/evals-langsmith"

if (Number(process.versions.node.split(".")[0]) < 24) {
  console.error(`Evaluation consumers require Node 24; received ${process.versions.node}.`)
  process.exit(1)
}
const directory = await mkdtemp(join(process.cwd(), "evals-node-"))
const Runnable = runnableExecutionPort("consumer")
const Environment = evaluationEnvironmentPort("consumer")
const runnable = defineRunnable({
  definition: {
    id: EvalId.make("function"),
    version: "1",
    description: "Typed function independent of an agent SDK",
    fingerprints: {}
  },
  input: Schema.String,
  output: Schema.String,
  evidence: Schema.Struct({ length: Schema.Number }),
  runnable: Runnable,
  environment: Environment,
  layer: Layer.succeed(Runnable, {
    execute: (input) => Effect.gen(function* () {
      const recorder = yield* TrialRecorder
      yield* recorder.record("function.output", { input })
      return { output: input.toUpperCase(), evidence: { length: input.length } }
    })
  }),
  environments: [{ id: "memory", layer: Layer.succeed(Environment, {
    open: () => Effect.succeed({}),
    inspect: () => Effect.succeed({ state: {}, references: [] })
  }) }]
})
export const app = defineEvaluationApp({
  id: "consumer",
  fingerprints: {},
  commands: {},
  calibrations: [],
  suites: [
    {
      id: EvalId.make("suite"),
      version: "1",
      purpose: "regression",
      description: "function contract",
      repetitions: 1,
      concurrency: 1,
      timeoutMs: 1000,
      tasks: [
        {
          id: EvalId.make("task"),
          version: "1",
          runnable: "function",
          dataset: "dataset",
          datasetVersion: "1",
          family: "function",
          split: "validation",
          review: "known",
          input: "hello",
          reference: "HELLO",
          graders: [
            { grader: "contract@1", projection: "output", scope: "trial" }
          ],
          provenance: "fixture"
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
  runnables: [runnable],
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
                value: context.input === "HELLO"
              }
            ],
            reason: "exact match",
            usage: unknownEvaluationUsage,
            metadata: {}
          })
      })
    }
  ]
})
const config = join(directory, "eval.config.ts")
const source = await readFile(new URL(import.meta.url), "utf8")
const declaration = source.slice(
  source.indexOf("const Runnable ="),
  source.indexOf("const config =")
)
await writeFile(
  config,
  `import { Effect, Layer, Option, Schema } from 'effect'; import { runnableExecutionPort, evaluationEnvironmentPort, TrialRecorder, EvidenceProjector, GraderAssessment, defineEvaluationApp, defineRunnable, EvalId, gradingContext, unknownEvaluationUsage } from '@xandreed/evals';\n${declaration}\nexport default app;\n`
)
const output = () => undefined
const code = await Effect.runPromise(
  evaluationCli(
    [
      "run",
      "suite",
      "--split",
      "validation",
      "--config",
      config,
      "--directory",
      directory
    ],
    { output }
  )
)
const run = await Effect.runPromise(
  Schema.decodeUnknownEffect(Schema.fromJsonString(EvaluationRun))(
    await readFile(join(directory, "report.json"), "utf8")
  )
)
if (
  code !== 0 ||
  !run.gates[0]?.passed ||
  run.trials[0]?.transcript.length !== 1
)
  process.exit(1)
if (
  langfuseExporter({
    baseUrl: "http://localhost",
    publicKey: "",
    secretKey: ""
  }).id !== "langfuse" ||
  langsmithExporter({
    apiUrl: "http://localhost",
    apiKey: "",
    project: "fixture"
  }).id !== "langsmith"
)
  process.exit(1)
console.log(
  "Node 24 typed function, TS app loading, local CLI and optional exporter imports passed"
)
