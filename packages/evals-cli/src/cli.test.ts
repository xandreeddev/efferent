import { EvaluationExport, EvaluationError, EvaluationRunStore, comparisonIssues, positiveInt } from "@xandreed/evals"
import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { evaluationCli } from "./cli.adapter.js"
import { EvaluationRunStoreFsLive, readRun, readText, writeJson } from "./adapters/evaluation-store.fs.adapter.js"
import { loadEvaluationApp } from "./config-loader.adapter.js"
import { cliFixture } from "./cli-fixture.testing.js"

const app = cliFixture()
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

test("--flag=value reads as --flag value, and a default directory is named after its run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-equals-"))
  expect(
    await Effect.runPromise(
      evaluationCli(["run", "suite", `--directory=${directory}`, "--split=validation"], { config: app, output })
    )
  ).toBe(0)
  expect((await Effect.runPromise(readRun(join(directory, "report.json")))).trials).toHaveLength(1)
  const workspace = await mkdtemp(join(tmpdir(), "evaluation-default-directory-"))
  const previous = process.cwd()
  await Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.sync(() => process.chdir(workspace)),
      () => evaluationCli(["run", "suite"], { config: app, output }),
      () => Effect.sync(() => process.chdir(previous))
    )
  )
  const runs = await readdir(join(workspace, ".eval-results", "runs"))
  const report = await Effect.runPromise(readRun(join(workspace, ".eval-results", "runs", runs[0]!, "report.json")))
  expect(runs).toEqual([report.id])
  expect(report.trials[0]?.id.startsWith(`${report.id}/`)).toBe(true)
})

test("a bad count flag is a usage error naming the flag, never a silent default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-flags-"))
  const refused = await Effect.runPromise(
    evaluationCli(["run", "suite", "--directory", directory, "--concurrency", "abc"], { config: app, output }).pipe(Effect.flip)
  )
  expect([refused.code, refused.message]).toEqual(["invalid", "--concurrency needs a positive integer, not \"abc\""])
  expect(await readdir(directory)).toEqual([])
  expect((await Effect.runPromise(positiveInt("--repetitions", 4, ["--repetitions", "0"]).pipe(Effect.flip))).code).toBe("invalid")
  expect((await Effect.runPromise(positiveInt("--repetitions", 4, ["--repetitions"]).pipe(Effect.flip))).code).toBe("invalid")
  expect(await Effect.runPromise(positiveInt("--repetitions", 4, ["--repetitions", "8"]))).toBe(8)
  expect(await Effect.runPromise(positiveInt("--repetitions", 4, []))).toBe(4)
})

test("a missing file is missing, a malformed one invalid, and a failed write leaves no temporary file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-files-"))
  const inspect = (args: ReadonlyArray<string>) => Effect.runPromise(evaluationCli(["inspect", ...args], { output }).pipe(Effect.flip))
  expect((await inspect(["--report", join(directory, "absent.json")])).code).toBe("missing")
  await writeFile(join(directory, "malformed.json"), "{}")
  expect((await inspect(["--report", join(directory, "malformed.json")])).code).toBe("invalid")
  expect((await inspect([])).message).toBe("inspect needs --report <path>")
  await mkdir(join(directory, "taken", "report.json", "occupied"), { recursive: true })
  const failed = await Effect.runPromise(writeJson(join(directory, "taken", "report.json"), {}).pipe(Effect.flip))
  expect(failed.code).toBe("persistence")
  expect(await readdir(join(directory, "taken"))).toEqual(["report.json"])
})

test("a failure the CLI wraps stays its cause, and the message says what failed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-causes-"))
  const unreadable = await Effect.runPromise(readText(directory).pipe(Effect.flip))
  expect(unreadable.code).toBe("persistence")
  expect(unreadable.message).toStartWith(`Cannot read ${directory}: EISDIR`)
  expect(unreadable.cause).toMatchObject({ code: "EISDIR" })
  await mkdir(join(directory, "taken", "report.json", "occupied"), { recursive: true })
  const unwritten = await Effect.runPromise(writeJson(join(directory, "taken", "report.json"), {}).pipe(Effect.flip))
  expect(unwritten.message).toStartWith("File operation failed: ")
  expect(unwritten.cause).toBeInstanceOf(Error)
  const unencoded = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* EvaluationRunStore
      return yield* store.writeTrial({ id: "unencodable" } as never)
    }).pipe(Effect.provide(EvaluationRunStoreFsLive(directory)), Effect.flip)
  )
  expect(unencoded.code).toBe("persistence")
  expect(unencoded.message).toStartWith("Trial unencodable does not encode: ")
  expect(unencoded.cause).toMatchObject({ _tag: "SchemaError" })
  const unloaded = await Effect.runPromise(loadEvaluationApp(join(directory, "absent.config.ts")).pipe(Effect.flip))
  expect(unloaded.code).toBe("invalid")
  expect(unloaded.message).toStartWith(`Cannot load evaluation configuration ${join(directory, "absent.config.ts")}: `)
  expect(unloaded.cause).toBeDefined()
})
