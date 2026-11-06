import { mkdir, readdir } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join, resolve } from "node:path"
import { Array as Arr, Effect, Layer, Option, Schema } from "effect"
import {
  EvaluationError,
  EvaluationRun,
  EvalId,
  runEvaluation,
  calibrateGrader,
  gradeEvaluation,
  comparisonIssues,
  parseEvaluationApp,
  ReviewBundle,
  reviewBundle,
  approveReviews,
  positiveAmount,
  positiveInt,
  type EvaluationApp,
  type EvaluationSelection,
  EvaluationServicesLive,
  EvaluationExport,
  type ExporterRegistration
} from "@xandreed/evals"
import {
  EvaluationRunStoreFsLive,
  fileIo,
  readJson,
  readRun,
  writeJson
} from "./adapters/evaluation-store.fs.adapter.js"
import { loadEvaluationApp } from "./config-loader.adapter.js"

/** @public */
export interface CliOptions {
  readonly config?: EvaluationApp
  readonly exporters?: ReadonlyArray<ExporterRegistration>
  readonly output?: (value: unknown) => void
}
/** `--flag=value` reads as `--flag value`. */
const tokensOf = (args: ReadonlyArray<string>) =>
  args.flatMap((arg) =>
    arg.startsWith("--") && arg.indexOf("=") > 2
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg]
  )
/** @public */
export const cliArguments = (raw: ReadonlyArray<string>) => {
  const args = tokensOf(raw)
  const command = args[0] ?? "help"
  const flagValue = (flag: string) => {
    const at = args.indexOf(flag)
    return Option.fromNullishOr(at < 0 ? undefined : args[at + 1])
  }
  /** The argument after each occurrence of `flag`, in order: none for one given last. */
  const occurrences = (flag: string) =>
    args.flatMap((item, at) => (item === flag ? [Option.fromNullishOr(args[at + 1])] : []))
  return {
    command,
    /** Every argument, `--flag=value` split in two. */
    tokens: args,
    args: args.slice(1),
    value: (flag: string, fallback: string) =>
      Option.getOrElse(flagValue(flag), () => fallback),
    /** A flag's non-empty value, else `fallback`'s, else a usage error. */
    required: (flag: string, fallback: Option.Option<string> = Option.none()) =>
      Option.match(
        Option.orElse(Option.filter(flagValue(flag), (value) => value.length > 0), () => fallback),
        {
          onNone: () =>
            Effect.fail(
              new EvaluationError({ code: "invalid", message: `${command} needs ${flag} <path>` })
            ),
          onSome: (value) => Effect.succeed(value)
        }
      ),
    has: (flag: string) => args.includes(flag),
    /**
     * A list flag's values: every occurrence (`--flag a --flag b`, `--flag=a`),
     * each split at commas, empty entries and repeats dropped in first-seen order.
     */
    list: (flag: string): ReadonlyArray<string> =>
      Arr.dedupe(
        occurrences(flag).flatMap((value) =>
          Option.match(value, { onNone: () => [], onSome: (text) => text.split(",").filter(Boolean) })
        )
      ),
    /**
     * A usage error (`invalid`) when one of `flags`, each read once, is given
     * more than once with different values: never the first one silently.
     */
    singleValued: (flags: ReadonlyArray<string>) =>
      Effect.forEach(flags, (flag) => {
        const given = Arr.dedupe(occurrences(flag).map(Option.getOrElse(() => "")))
        return given.length > 1
          ? Effect.fail(
              new EvaluationError({
                code: "invalid",
                message: `${flag} takes one value, not ${given.map((value) => JSON.stringify(value)).join(" and ")}`
              })
            )
          : Effect.void
      }, { concurrency: 1, discard: true }),
    ids: args.slice(
      1,
      args.findIndex((item, index) => index > 0 && item.startsWith("--")) < 0
        ? args.length
        : args.findIndex((item, index) => index > 0 && item.startsWith("--"))
    )
  }
}
/**
 * The built-in commands' single-valued flags: one given twice with different
 * values is a usage error. The list flags (`--task`, `--candidate`,
 * `--grader`, `--exporter`) merge every occurrence instead.
 */
const SINGLE_VALUED_FLAGS = [
  "--config",
  "--directory",
  "--split",
  "--repetitions",
  "--concurrency",
  "--timeout-ms",
  "--environment",
  "--budget-usd",
  "--report",
  "--from",
  "--import",
  "--baseline",
  "--candidate-report"
]
const help =
  "efferent-eval <list|validate|estimate|run|calibrate|grade|inspect|compare|review|export> [ids] --config eval.config.ts [--directory dir] [--split calibration|validation] [--repetitions n] [--environment id] [--task id] [--candidate id] [--execute-only] [--budget-usd amount] [--exporter langfuse,langsmith]\nGrade captured work: grade --from execution.json [--grader id] --directory revision\n--task, --candidate, --grader and --exporter repeat or take a comma list (--task a --task b, --task a,b); any other flag takes one value.\nLocal reports are authoritative. Remote export is opt-in. App configurations may register additional commands."
/** A run's spend and the trials its budget skipped, for a summary: nothing for a run that recorded no spend. */
const spendSummary = (run: EvaluationRun) =>
  run.spend === undefined
    ? {}
    : {
        skipped: run.trials.filter((trial) => trial.status === "skipped").length,
        spend: { budget: Option.getOrNull(run.spend.budget), settled: run.spend.settled }
      }
const requireFreshDirectory = (directory: string) =>
  fileIo(() => mkdir(directory, { recursive: true })).pipe(
    Effect.andThen(fileIo(() => readdir(directory))),
    Effect.flatMap((names) =>
      names.some((name) => name === "execution.json" || name === "report.json")
        ? Effect.fail(
            new EvaluationError({
              code: "invalid",
              message:
                "Execution/report already exists; choose a fresh --directory"
            })
          )
        : Effect.void
    )
  )
export const evaluationCli = Effect.fnUntraced(
  function* (
    args: ReadonlyArray<string>,
    options: CliOptions = {}
  ): Effect.fn.Return<number, EvaluationError> {
    const line = cliArguments(args)
    const output =
      options.output ??
      ((value: unknown) =>
        console.log(
          typeof value === "string" ? value : JSON.stringify(value, null, 2)
        ))
    if (["help", "--help", "-h"].includes(line.command)) {
      output(help)
      return 0
    }
    if (line.command === "inspect") {
      yield* line.singleValued(SINGLE_VALUED_FLAGS)
      const run = yield* readRun(
        yield* line.required("--report", Option.fromNullishOr(line.ids[0]))
      )
      output(
        line.has("--summary")
          ? {
              id: run.id,
              application: run.application,
              phase: run.phase,
              trials: run.trials.length,
              completed: run.trials.filter(
                (trial) => trial.status === "completed"
              ).length,
              failures: run.failures.length,
              ...spendSummary(run),
              gates: run.gates.map((gate) => ({
                ...gate,
                value: Option.getOrNull(gate.value)
              }))
            }
          : yield* Schema.encodeEffect(EvaluationRun)(run).pipe(
              Effect.mapError(
                (error) =>
                  new EvaluationError({
                    code: "invalid",
                    message: `Run ${run.id} does not encode: ${error.message}`,
                    cause: error
                  })
              )
            )
      )
      return 0
    }
    if (line.command === "compare") {
      yield* line.singleValued(SINGLE_VALUED_FLAGS)
      const baseline = yield* readRun(yield* line.required("--baseline"))
      const candidate = yield* readRun(
        yield* line.required("--candidate-report")
      )
      const issues = comparisonIssues(baseline, candidate)
      output({
        issues,
        baseline: baseline.gates.map((gate) => ({
          ...gate,
          value: Option.getOrNull(gate.value)
        })),
        candidate: candidate.gates.map((gate) => ({
          ...gate,
          value: Option.getOrNull(gate.value)
        }))
      })
      return issues.length ? 2 : 0
    }
    // App commands read their own flags; the configuration path is the CLI's.
    yield* line.singleValued(["--config"])
    const app =
      options.config ??
      (yield* loadEvaluationApp(line.value("--config", "eval.config.ts"), line.tokens))
    // `inspect`, `compare` and `help` load no app, so they open no span. The
    // command's span opens inside the app's observability layer, which closes
    // with the command (an interrupted one too) and so flushes it.
    return yield* appCommand(line, app, options, output).pipe(
      Effect.provide(app.observability ?? Layer.empty)
    )
  }
)
type CliLine = ReturnType<typeof cliArguments>

/**
 * A command over a loaded app: one `eval.cli` span carrying `eval.command`,
 * which the logs under it carry too.
 */
const appCommand = Effect.fn("eval.cli")(
  function* (
    line: CliLine,
    app: EvaluationApp,
    options: CliOptions,
    output: (value: unknown) => void
  ): Effect.fn.Return<number, EvaluationError> {
    const extension = app.commands[line.command]
    if (extension) {
      const result = yield* extension(line.args)
      output(result)
      return typeof result === "number" ? result : 0
    }
    yield* line.singleValued(SINGLE_VALUED_FLAGS)
    if (line.command === "list") {
      output({
        application: app.id,
        suites: app.suites.map((suite) => ({
          id: suite.id,
          purpose: suite.purpose,
          tasks: suite.tasks.length,
          candidates: suite.candidates.map((candidate) => candidate.id)
        })),
        calibrations: app.calibrations.map((calibration) => ({
          id: calibration.id,
          grader: calibration.grader,
          tasks: calibration.suite.tasks.length
        })),
        runnables: app.runnables.map((entry) => entry.definition),
        environments: Array.from(new Set(app.runnables.flatMap((entry) => entry.environments.map((environment) => environment.id))))
      })
      return 0
    }
    if (line.command === "validate") {
      yield* parseEvaluationApp(app)
      output({ application: app.id, valid: true })
      return 0
    }
    if (line.command === "estimate") {
      output({
        suites: app.suites.map((suite) => ({
          id: suite.id,
          executions:
            suite.tasks.length * suite.candidates.length * suite.repetitions,
          modelCostUsd: null
        })),
        note: "Applications supply model prices and measured cost estimates through their estimate command."
      })
      return 0
    }
    // One id names both the run (or grading revision) and its default directory.
    const runId = randomUUID()
    const directory = resolve(
      line.value("--directory", join(".eval-results", "runs", runId))
    )
    if (line.command === "export") {
      const run = yield* readRun(yield* line.required("--report"))
      const selected = line.list("--exporter")
      if (!selected.length)
        return yield* Effect.fail(
          new EvaluationError({
            code: "invalid",
            message: "Export requires --exporter"
          })
        )
      const receipts = yield* Effect.forEach(selected, (id) => {
        const exporter = (options.exporters ?? app.exporters)?.find(
          (entry) => entry.id === id
        )
        return exporter
          ? Effect.gen(function* () {
              const port = yield* EvaluationExport
              return yield* port.exportRun(run)
            }).pipe(Effect.provide(Layer.fresh(exporter.layer)), Effect.scoped)
          : Effect.fail(
              new EvaluationError({
                code: "invalid",
                message: `No configured exporter ${id}`
              })
            )
      }, { concurrency: 1 })
      yield* writeJson(resolve(directory, "export-receipts.json"), receipts)
      output(receipts)
      return 0
    }
    if (line.command === "review") {
      const run = yield* readRun(yield* line.required("--report"))
      const bundle = line.has("--import")
        ? yield* readJson(yield* line.required("--import"), ReviewBundle).pipe(
            Effect.flatMap((review) => approveReviews(run, review))
          )
        : reviewBundle(run)
      yield* Schema.encodeEffect(ReviewBundle)(bundle).pipe(
        Effect.mapError(
          (error) =>
            new EvaluationError({
              code: "invalid",
              message: `Review bundle for ${run.id} does not encode: ${error.message}`,
              cause: error
            })
        ),
        Effect.flatMap((encoded) =>
          writeJson(
            resolve(
              directory,
              line.has("--import") ? "approved-reviews.json" : "review.json"
            ),
            encoded
          )
        )
      )
      output({
        directory,
        reviewed: bundle.items.filter((item) => item.approved).length
      })
      return 0
    }
    if (line.command === "grade") {
      const saved = yield* readRun(yield* line.required("--from"))
      yield* requireFreshDirectory(directory)
      const run = yield* gradeEvaluation(app, saved, runId, {
        graders: line.list("--grader")
      }).pipe(
        Effect.provide(
          Layer.merge(
            EvaluationServicesLive(app),
            EvaluationRunStoreFsLive(directory)
          )
        )
      )
      output({
        directory,
        source: saved.id,
        phase: run.phase,
        revision: run.id,
        trials: run.trials.length,
        gates: run.gates.map((gate) => ({
          ...gate,
          value: Option.getOrNull(gate.value)
        }))
      })
      return run.failures.length ||
        run.gates.some((gate) => gate.mode === "blocking" && !gate.passed)
        ? 2
        : 0
    }
    const selection: EvaluationSelection = {
      ids: line.ids,
      tasks: line.list("--task"),
      executeOnly: line.has("--execute-only"),
      candidates: line.list("--candidate"),
      split: line.value(
        "--split",
        line.command === "calibrate" ? "calibration" : "validation"
      ),
      ...(line.has("--repetitions")
        ? { repetitions: yield* positiveInt("--repetitions", 1, line.args) }
        : {}),
      ...(line.has("--concurrency")
        ? { concurrency: yield* positiveInt("--concurrency", 1, line.args) }
        : {}),
      ...(line.has("--timeout-ms")
        ? { timeoutMs: yield* positiveInt("--timeout-ms", 60_000, line.args) }
        : {}),
      ...(line.has("--environment")
        ? { environment: line.value("--environment", "") }
        : {}),
      ...Option.match(yield* positiveAmount("--budget-usd", line.args), {
        onNone: () => ({}),
        onSome: (spendBudget) => ({ spendBudget })
      })
    }
    if (!["run", "calibrate"].includes(line.command))
      return yield* Effect.fail(
        new EvaluationError({
          code: "invalid",
          message: `Unknown command ${line.command}`
        })
      )
    yield* requireFreshDirectory(directory)
    const run = yield* (
      line.command === "calibrate"
        ? calibrateGrader(app, line.ids[0] ?? "", runId, selection)
        : runEvaluation(app, runId, selection)
    ).pipe(
      Effect.provide(
        Layer.merge(
          EvaluationServicesLive(app),
          EvaluationRunStoreFsLive(directory)
        )
      )
    )
    const selectedExporters = line.list("--exporter")
    const exports = yield* Effect.forEach(selectedExporters, (id) => {
      const exporter = (options.exporters ?? app.exporters)?.find(
        (entry) => entry.id === id
      )
      return (
        exporter
          ? Effect.gen(function* () {
              const port = yield* EvaluationExport
              return yield* port.exportRun(run)
            }).pipe(Effect.provide(Layer.fresh(exporter.layer)), Effect.scoped)
          : Effect.fail(
              new EvaluationError({
                code: "invalid",
                message: `No configured exporter ${id}`
              })
            )
      ).pipe(
        Effect.match({
          onSuccess: (receipt) => ({ provider: id, receipt }),
          onFailure: (error) => ({ provider: id, error: error.message })
        })
      )
    }, { concurrency: 1 })
    if (exports.length)
      yield* writeJson(resolve(directory, "export-receipts.json"), exports)
    output({
      directory,
      phase: run.phase,
      artifact: run.phase === "executed" ? "execution.json" : "report.json",
      exports,
      trials: run.trials.length,
      completed: run.trials.filter((trial) => trial.status === "completed")
        .length,
      ...spendSummary(run),
      gates: run.gates.map((gate) => ({
        ...gate,
        value: Option.getOrNull(gate.value)
      }))
    })
    return run.failures.length ||
      run.gates.some((gate) => gate.mode === "blocking" && !gate.passed)
      ? 2
      : 0
  },
  (effect, line) =>
    Effect.annotateCurrentSpan("eval.command", line.command).pipe(
      Effect.andThen(effect),
      Effect.annotateLogs("eval.command", line.command)
    )
)
