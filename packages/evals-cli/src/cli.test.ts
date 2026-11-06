import { EvalId, EvalPath, EvaluationExport, EvaluationError, EvaluationRunStore, TranscriptEvent, Trial, TrialRecorder, comparisonIssues, positiveAmount, positiveInt, type EvaluationApp } from "@xandreed/evals"
import { ModelSpend } from "@xandreed/core"
import { spanRecorder } from "@xandreed/evals/testing/fixture.testing"
import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Array as Arr, Deferred, Effect, Fiber, Layer, Option, Order, Schema, Tracer } from "effect"
import { cliArguments, evaluationCli } from "./cli.adapter.js"
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

/** `base` with a recording tracer as its observability layer, whose release notes the spans still open when it closes. */
const observed = (base: EvaluationApp) => {
  const recorder = spanRecorder()
  const openAtClose: Array<ReadonlyArray<string>> = []
  const observability = Layer.merge(
    Layer.succeed(Tracer.Tracer, recorder.tracer),
    Layer.effectDiscard(Effect.addFinalizer(() => Effect.sync(() => {
      openAtClose.push(recorder.spans.filter((span) => span.status._tag === "Started").map((span) => span.name))
    })))
  )
  return { ...recorder, openAtClose, app: { ...base, observability } }
}

test("a command over a loaded app is one eval.cli span in the app's observability layer, over the run, its trials and its grading", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-traces-"))
  const { app: traced, named, parentOf, openAtClose } = observed(app)
  expect(await Effect.runPromise(evaluationCli(["run", "suite", "--directory", directory], { config: traced, output }))).toBe(0)
  expect(named("eval.cli").map((span) => [span.attributes.get("eval.command"), Option.isNone(span.parent)])).toEqual([["run", true]])
  expect(named("eval.run").map(parentOf)).toEqual(["eval.cli"])
  expect(named("eval.trial").map(parentOf)).toEqual(["eval.run"])
  expect(named("eval.regrade").map(parentOf)).toEqual(["eval.run"])
  expect(named("eval.grade").map(parentOf)).toEqual(["eval.regrade"])
  // The layer closed with the command, once every span had ended: what it flushes is the whole trace.
  expect(openAtClose).toEqual([[]])
  // inspect loads no app, so it opens no span.
  await Effect.runPromise(evaluationCli(["inspect", "--report", join(directory, "report.json")], { config: traced, output }))
  expect(named("eval.cli")).toHaveLength(1)
})

test("an interrupted command still closes the app's observability layer, after its spans have ended", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-interrupted-traces-"))
  const { named, openAtClose } = await Effect.runPromise(Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const traced = observed(cliFixture(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))))
    const running = yield* evaluationCli(["run", "suite", "--directory", directory], { config: traced.app, output }).pipe(Effect.forkChild)
    yield* Deferred.await(started)
    yield* Fiber.interrupt(running)
    return traced
  }))
  expect(named("eval.cli").map((span) => span.status._tag)).toEqual(["Ended"])
  expect(named("eval.trial").map((span) => span.status._tag)).toEqual(["Ended"])
  expect(openAtClose).toEqual([[]])
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

test("a list flag merges its repeated and comma forms, repeats dropped in first-seen order; ids are unaffected", () => {
  const line = cliArguments(["run", "first", "second", "--task", "b,a", "--task=c", "--split", "all", "--task", "a,,b", "--task="])
  expect(line.list("--task")).toEqual(["b", "a", "c"])
  expect(line.list("--candidate")).toEqual([])
  expect(line.ids).toEqual(["first", "second"])
  expect(line.value("--split", "validation")).toBe("all")
})

/** The fixture app with three tasks and two candidates in its suite, so a selection shows in the trials. */
const wideApp: EvaluationApp = {
  ...app,
  suites: app.suites.map((suite) => ({
    ...suite,
    tasks: ["case", "second", "third"].map((id) => ({ ...suite.tasks[0]!, id: EvalId.make(id) })),
    candidates: ["code", "other"].map((id) => ({ ...suite.candidates[0]!, id: EvalId.make(id) }))
  }))
}

test("repeated --task, --candidate and --exporter flags select every value given, each once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-list-flags-"))
  const exported: Array<string> = []
  const exporter = (id: string) => ({
    id,
    layer: Layer.succeed(EvaluationExport, {
      exportRun: () => Effect.sync(() => exported.push(id)).pipe(Effect.as({ provider: id, runId: "run", url: "", exported: 0, at: 0, mappings: {} }))
    })
  })
  const code = await Effect.runPromise(evaluationCli(
    ["run", "suite", "--directory", directory, "--task", "case", "--task=third", "--task", "case,third",
      "--candidate", "other", "--exporter", "second", "--exporter", "first,second"],
    { config: wideApp, output, exporters: [exporter("first"), exporter("second")] }
  ))
  expect(code).toBe(0)
  const run = await Effect.runPromise(readRun(join(directory, "report.json")))
  expect(run.trials.map((trial): ReadonlyArray<string> => [trial.candidate.id, trial.task.id])).toEqual([["other", "case"], ["other", "third"]])
  expect(exported).toEqual(["second", "first"])
})

test("a single-valued flag given twice with different values is a usage error, never its first value", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-single-flags-"))
  const refused = (args: ReadonlyArray<string>, config: EvaluationApp | undefined = app) =>
    Effect.runPromise(evaluationCli(args, { ...(config ? { config } : {}), output }).pipe(
      Effect.flip,
      Effect.map((error) => [error.code, error.message])
    ))
  expect(await refused(["run", "suite", "--directory", directory, "--split", "validation", "--split=calibration"])).toEqual(
    ["invalid", "--split takes one value, not \"validation\" and \"calibration\""]
  )
  expect(await refused(["run", "suite", "--directory", directory, "--repetitions", "1", "--repetitions", "3"])).toEqual(
    ["invalid", "--repetitions takes one value, not \"1\" and \"3\""]
  )
  expect(await refused(["run", "suite", "--directory", directory, "--budget-usd", "1", "--budget-usd"])).toEqual(
    ["invalid", "--budget-usd takes one value, not \"1\" and \"\""]
  )
  expect(await refused(["inspect", "--report", "a.json", "--report", "b.json"], undefined)).toEqual(
    ["invalid", "--report takes one value, not \"a.json\" and \"b.json\""]
  )
  expect(await refused(["list", "--config", "a.ts", "--config=b.ts"])).toEqual(
    ["invalid", "--config takes one value, not \"a.ts\" and \"b.ts\""]
  )
  // Nothing ran: the refused commands wrote nothing.
  expect(await readdir(directory)).toEqual([])
  // The same value twice is one value.
  expect(await Effect.runPromise(evaluationCli(
    ["run", "suite", "--directory", directory, "--split", "validation", "--split=validation"],
    { config: app, output }
  ))).toBe(0)
  // An app command reads its own flags as given.
  const echoed: Array<ReadonlyArray<string>> = []
  const echoing: EvaluationApp = { ...app, commands: { echo: (args) => Effect.sync(() => echoed.push(args)).pipe(Effect.as("echoed")) } }
  expect(await Effect.runPromise(evaluationCli(["echo", "--split", "a", "--split", "b"], { config: echoing, output }))).toBe(0)
  expect(echoed).toEqual([["--split", "a", "--split", "b"]])
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

test("a running trial's events are appended to its event file (mode 0600), which goes once the trial settles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-events-"))
  const trials = join(directory, "trials")
  const recorded = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const config = cliFixture((input) => TrialRecorder.use((recorder) => recorder.record("tool.started", { input }).pipe(
    Effect.andThen(recorder.record("tool.completed", { output: input })),
  )).pipe(
    Effect.andThen(Effect.sync(() => recorded.resolve())),
    Effect.andThen(Effect.promise(() => release.promise)),
    Effect.as({ output: input, evidence: {} }),
  ))
  const exited = Effect.runPromise(evaluationCli(["run", "suite", "--directory", directory], { config, output }))
  await recorded.promise
  const [events, trial] = Arr.sort(await readdir(trials), Order.String)
  expect([events?.endsWith(".events.jsonl"), trial?.endsWith(".json")]).toEqual([true, true])
  const lines = (await readFile(join(trials, events!), "utf8")).split("\n")
  expect(lines.at(-1)).toBe("")
  const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(TranscriptEvent))
  const appended = lines.slice(0, -1).map((line) => decodeEvent(line))
  expect(appended.map((event) => [event.sequence, event.kind])).toEqual([[0, "tool.started"], [1, "tool.completed"]])
  expect((await stat(join(trials, events!))).mode & 0o777).toBe(0o600)
  expect(Schema.decodeUnknownSync(Schema.fromJsonString(Trial))(await readFile(join(trials, trial!), "utf8")).transcript).toEqual([])
  release.resolve()
  expect(await exited).toBe(0)
  expect(await readdir(trials)).toEqual([trial!])
  const report = await Effect.runPromise(readRun(join(directory, "report.json")))
  expect(report.trials[0]?.transcript).toEqual(appended)
})

// A superuser reads any file, so the unreadable one needs an ordinary user.
test.skipIf(process.getuid?.() === 0)("a read is missing only for ENOENT: a file it may not read is persistence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-reads-"))
  const absent = await Effect.runPromise(readText(join(directory, "absent.json")).pipe(Effect.flip))
  expect([absent.code, absent.message]).toEqual(["missing", `No file at ${join(directory, "absent.json")}`])
  await writeFile(join(directory, "locked.json"), "{}", { mode: 0o000 })
  const locked = await Effect.runPromise(readText(join(directory, "locked.json")).pipe(Effect.flip))
  expect(locked.code).toBe("persistence")
  expect(locked.message).toStartWith(`Cannot read ${join(directory, "locked.json")}: EACCES`)
  expect(locked.cause).toMatchObject({ code: "EACCES" })
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
  const unappended = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* EvaluationRunStore
      return yield* store.appendTranscript(EvalPath.make("run/suite/candidate/task/1"), { id: "unencodable" } as never)
    }).pipe(Effect.provide(EvaluationRunStoreFsLive(directory)), Effect.flip)
  )
  expect([unappended.code, unappended.cause]).toMatchObject(["persistence", { _tag: "SchemaError" }])
  expect(unappended.message).toStartWith("Event unencodable does not encode: ")
  const unloaded = await Effect.runPromise(loadEvaluationApp(join(directory, "absent.config.ts")).pipe(Effect.flip))
  expect(unloaded.code).toBe("invalid")
  expect(unloaded.message).toStartWith(`Cannot load evaluation configuration ${join(directory, "absent.config.ts")}: `)
  expect(unloaded.cause).toBeDefined()
})

// The configuration loader is tsx's, so the command line runs on Node here (as in run-main.adapter.test.ts).
test("a configuration whose default export is not an app is refused by shape", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-config-"))
  await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }))
  await writeFile(join(directory, "number.config.ts"), "export default 42\n")
  await writeFile(join(directory, "factory.config.ts"), "export default (args: ReadonlyArray<string>) => ({ id: args.join(\" \") })\n")
  const validate = async (file: string) => {
    const child = Bun.spawn(
      ["node", "--import", import.meta.resolve("tsx/esm"), join(import.meta.dir, "main.ts"), "validate", "--config", join(directory, file)],
      { stdout: "ignore", stderr: "pipe" }
    )
    return [await child.exited, (await new Response(child.stderr).text()).trim()]
  }
  expect(await validate("number.config.ts")).toEqual([1, "invalid: Evaluation app refused (1 violation): shape: Expected object"])
  expect(await validate("factory.config.ts")).toEqual([1, `invalid: Evaluation app refused (8 violations): ${
    ["suites", "calibrations", "runnables", "graders", "projections"].map((key) => `shape at ${key}: Missing key`).join("; ")}; and 3 more`])
}, 30_000)

/** The fixture, its one send reserving 1 in the trial's ledger and settling at 0.75; a refused send fails the trial. */
const spendingApp = cliFixture((input) => Effect.gen(function* () {
  const ledger = yield* ModelSpend
  const hold = yield* ledger.reserve({ amount: 1, caps: {} })
  yield* ledger.settle(hold, 0.75)
  return { output: input, evidence: {} }
}).pipe(Effect.mapError((error) => new EvaluationError({ code: "provider", message: error.message, cause: error }))))

/** `run` over the spending fixture, four samples, with `flags`: its exit code, what it printed and its report. */
const budgetedRun = async (flags: ReadonlyArray<string>) => {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-budget-"))
  const printed: unknown[] = []
  const code = await Effect.runPromise(
    evaluationCli(["run", "suite", "--directory", directory, "--repetitions", "4", ...flags], { config: spendingApp, output: (value) => printed.push(value) })
  )
  const report: { spend?: unknown; failures: ReadonlyArray<string>; trials: ReadonlyArray<{ status: string; reason: string; spend?: unknown }> } =
    JSON.parse(await readFile(join(directory, "report.json"), "utf8"))
  return { code, printed: printed[0], report, directory }
}

test("run --budget-usd under the budget runs every trial and records what each one and the run settled", async () => {
  const { code, printed, report } = await budgetedRun(["--budget-usd", "5"])
  expect(code).toBe(0)
  expect(report.trials.map((trial) => [trial.status, trial.spend])).toEqual(Array.from({ length: 4 }, () => ["completed", { settled: 0.75 }]))
  expect(report.spend).toEqual({ budget: 5, settled: 3 })
  expect(printed).toMatchObject({ trials: 4, completed: 4, skipped: 0, spend: { budget: 5, settled: 3 } })
})

test("run --budget-usd over the budget keeps the finished trials and reports the rest as skipped for budget, not as failures", async () => {
  const { code, printed, report, directory } = await budgetedRun(["--budget-usd=2"])
  expect(report.trials.map((trial) => [trial.status, trial.spend])).toEqual([
    ["completed", { settled: 0.75 }],
    ["completed", { settled: 0.75 }],
    ["skipped", { settled: 0 }],
    ["skipped", undefined],
  ])
  expect(report.trials.slice(2).every((trial) => trial.reason.startsWith("budget: "))).toBe(true)
  expect(report.failures).toEqual([])
  expect(report.spend).toEqual({ budget: 2, settled: 1.5 })
  expect(printed).toMatchObject({ trials: 4, completed: 2, skipped: 2, spend: { budget: 2, settled: 1.5 } })
  // The fixture's blocking gate is not measured over skipped trials, so it fails, as an incomplete run's does.
  expect(code).toBe(2)
  expect((await readdir(join(directory, "trials"))).filter((name) => name.endsWith(".json"))).toHaveLength(4)
  const summaries: unknown[] = []
  await Effect.runPromise(evaluationCli(["inspect", "--summary", "--report", join(directory, "report.json")], { output: (value) => summaries.push(value) }))
  expect(summaries[0]).toMatchObject({ completed: 2, failures: 0, skipped: 2, spend: { budget: 2, settled: 1.5 } })
})

test("a run that metered no spend prints and stores no spend", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-unmetered-"))
  const printed: unknown[] = []
  await Effect.runPromise(evaluationCli(["run", "suite", "--directory", directory], { config: app, output: (value) => printed.push(value) }))
  expect(Object.keys(printed[0] as object)).not.toContain("spend")
  expect(await readFile(join(directory, "report.json"), "utf8")).not.toContain("spend")
})

test("a bad --budget-usd is a usage error naming the flag, before anything runs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-budget-flag-"))
  const refusals = await Effect.runPromise(Effect.forEach([["0"], ["-1"], ["abc"], ["Infinity"], []], (value) =>
    evaluationCli(["run", "suite", "--directory", directory, "--budget-usd", ...value], { config: spendingApp, output }).pipe(
      Effect.flip,
      Effect.map((error) => [error.code, error.message])
    ), { concurrency: 1 }))
  expect(refusals).toEqual([
    ["invalid", "--budget-usd needs a positive number, not \"0\""],
    ["invalid", "--budget-usd needs a positive number, not \"-1\""],
    ["invalid", "--budget-usd needs a positive number, not \"abc\""],
    ["invalid", "--budget-usd needs a positive number, not \"Infinity\""],
    ["invalid", "--budget-usd needs a positive number"],
  ])
  expect(await readdir(directory)).toEqual([])
  expect(await Effect.runPromise(positiveAmount("--budget-usd", ["--budget-usd", "0.25"]))).toEqual(Option.some(0.25))
  expect(await Effect.runPromise(positiveAmount("--budget-usd", []))).toEqual(Option.none())
})

test("calibrate --budget-usd caps the calibration's run as run's", async () => {
  const calibrating: EvaluationApp = {
    ...spendingApp,
    calibrations: [{
      id: EvalId.make("judge"), version: "1", grader: spendingApp.graders[0]!.definition,
      suite: { ...spendingApp.suites[0]!, id: EvalId.make("judge-suite"), repetitions: 4 },
    }],
  }
  const directory = await mkdtemp(join(tmpdir(), "evaluation-calibrate-budget-"))
  await Effect.runPromise(
    evaluationCli(["calibrate", "judge", "--split", "validation", "--directory", directory, "--budget-usd", "2"], { config: calibrating, output })
  )
  const report = await Effect.runPromise(readRun(join(directory, "report.json")))
  expect(report.trials.map((trial) => trial.status)).toEqual(["completed", "completed", "skipped", "skipped"])
  expect(report.spend).toEqual({ budget: Option.some(2), settled: 1.5 })
})
