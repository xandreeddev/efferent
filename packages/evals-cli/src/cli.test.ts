import {
  runnableExecutionPort,
  evaluationEnvironmentPort,
  defineRunnable,
  TrialRecorder,
  EvaluationExport,
  EvidenceProjector,
  GraderAssessment
} from "@xandreed/evals"
import { expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Option, Layer } from "effect"
import {
  EvalId,
  EvaluationError,
  unknownEvaluationUsage,
  gradingContext,
  comparisonIssues,
  type EvaluationApp
} from "@xandreed/evals"
import { Schema } from "effect"
import { evaluationCli } from "./cli.adapter.js"

const FunctionRunnable = runnableExecutionPort<string, string, Schema.Json, Record<string, never>>("cli-fixture")
const FunctionEnvironment = evaluationEnvironmentPort<string, Record<string, never>>("cli-fixture")
const app: EvaluationApp = {
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
    layer: Layer.succeed(FunctionRunnable, {
      execute: (input) => Effect.succeed({ output: input, evidence: {} })
    }),
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
}
const output = () => undefined

test("failed export preserves the local result; inspect works without app configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-cli-"))
  const code = await Effect.runPromise(
    evaluationCli(
      [
        "run",
        "suite",
        "--split",
        "validation",
        "--directory",
        directory,
        "--exporter",
        "broken"
      ],
      {
        config: app,
        output,
        exporters: [
          {
            id: "broken",
            layer: Layer.succeed(EvaluationExport, {
              exportRun: () =>
                Effect.fail(
                  new EvaluationError({ code: "provider", message: "offline" })
                )
            })
          }
        ]
      }
    )
  )
  expect(code).toBe(0)
  const report = JSON.parse(
    await readFile(join(directory, "report.json"), "utf8")
  )
  expect(report.trials[0]?.status).toBe("completed")
  expect(
    JSON.parse(
      await readFile(join(directory, "export-receipts.json"), "utf8")
    )[0]?.error
  ).toBe("offline")
  expect(
    await Effect.runPromise(
      evaluationCli(["inspect", "--report", join(directory, "report.json")], {
        output
      })
    )
  ).toBe(0)
})

test("grading creates consistent revision trial identities and keeps the original execution", async () => {
  const source = await mkdtemp(join(tmpdir(), "evaluation-source-"))
  const revision = await mkdtemp(join(tmpdir(), "evaluation-revision-"))
  await Effect.runPromise(
    evaluationCli(
      [
        "run",
        "suite",
        "--split",
        "validation",
        "--execute-only",
        "--directory",
        source
      ],
      { config: app, output }
    )
  )
  const original = await readFile(join(source, "execution.json"), "utf8")
  expect(
    await Effect.runPromise(
      evaluationCli(
        [
          "grade",
          "--from",
          join(source, "execution.json"),
          "--directory",
          revision
        ],
        { config: app, output }
      )
    )
  ).toBe(0)
  const report = JSON.parse(
    await readFile(join(revision, "report.json"), "utf8")
  )
  expect(report.trials[0]?.runId).toBe(report.id)
  expect(report.trials[0]?.id.startsWith(`${report.id}/`)).toBe(true)
  expect(await readFile(join(source, "execution.json"), "utf8")).toBe(original)
  await expect(
    Effect.runPromise(
      evaluationCli(["run", "suite", "--directory", source], {
        config: app,
        output
      })
    )
  ).rejects.toThrow("fresh --directory")
})

test("run defaults to validation and summary inspection excludes captured content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-default-"))
  expect(
    await Effect.runPromise(
      evaluationCli(["run", "suite", "--directory", directory], {
        config: app,
        output
      })
    )
  ).toBe(0)
  const values: unknown[] = []
  await Effect.runPromise(
    evaluationCli(
      ["inspect", "--summary", "--report", join(directory, "report.json")],
      { output: (value) => values.push(value) }
    )
  )
  expect(values[0]).toMatchObject({ completed: 1, phase: "graded" })
  expect(JSON.stringify(values)).not.toContain("hello")
})

test("comparisons require the same grading policy and all bound grades", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-comparison-"))
  await Effect.runPromise(
    evaluationCli(["run", "suite", "--directory", directory], {
      config: app,
      output
    })
  )
  const { readRun } = await import("./adapters/evaluation-store.fs.adapter.js")
  const saved = await Effect.runPromise(readRun(join(directory, "report.json")))
  expect(
    comparisonIssues(saved, {
      ...saved,
      fingerprints: {
        ...saved.fingerprints,
        gradingConfiguration: "changed-rubric"
      }
    })
  ).toContain("Grader definitions or projection policy differs")
  expect(
    comparisonIssues(saved, {
      ...saved,
      trials: saved.trials.map((trial) => ({ ...trial, grades: [] }))
    })
  ).toContain("Incomplete trials or grade coverage")
})
