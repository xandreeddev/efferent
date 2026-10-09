import { mkdir, readFile, readdir } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { Effect, Layer, Option, Schema } from "effect"
import {
  EvaluationError,
  EvaluationRun,
  EvalId,
  runEvaluation,
  calibrateGrader,
  gradeEvaluation,
  comparisonIssues,
  validateEvaluationApp,
  ReviewBundle,
  reviewBundle,
  approveReviews,
  type EvaluationApp,
  type EvaluationSelection,
  EvaluationServicesLive,
  EvaluationExport,
  type ExporterRegistration
} from "@xandreed/evals"
import {
  EvaluationRunStoreFsLive,
  fileIo,
  readRun,
  writeJson
} from "./adapters/evaluation-store.fs.adapter.js"
import { loadEvaluationApp } from "./config-loader.adapter.js"

export interface CliOptions {
  readonly config?: EvaluationApp
  readonly exporters?: ReadonlyArray<ExporterRegistration>
  readonly output?: (value: unknown) => void
}
export const cliArguments = (args: ReadonlyArray<string>) => ({
  command: args[0] ?? "help",
  args: args.slice(1),
  value: (flag: string, fallback: string) => {
    const at = args.indexOf(flag)
    return at < 0 ? fallback : (args[at + 1] ?? fallback)
  },
  has: (flag: string) => args.includes(flag),
  ids: args.slice(
    1,
    args.findIndex((item, index) => index > 0 && item.startsWith("--")) < 0
      ? args.length
      : args.findIndex((item, index) => index > 0 && item.startsWith("--"))
  )
})
const help =
  "efferent-eval <list|validate|estimate|run|calibrate|grade|inspect|compare|review|export> [ids] --config eval.config.ts [--directory dir] [--split calibration|validation] [--repetitions n] [--environment id] [--task id] [--execute-only] [--exporter langfuse,langsmith]\nGrade captured work: grade --from execution.json [--grader id] --directory revision\nLocal reports are authoritative. Remote export is opt-in. App configurations may register additional commands."
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
export const evaluationCli = (
  args: ReadonlyArray<string>,
  options: CliOptions = {}
): Effect.Effect<number, EvaluationError> =>
  Effect.gen(function* () {
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
      const run = yield* readRun(line.value("--report", line.ids[0] ?? ""))
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
                    message: String(error)
                  })
              )
            )
      )
      return 0
    }
    if (line.command === "compare") {
      const baseline = yield* readRun(line.value("--baseline", ""))
      const candidate = yield* readRun(line.value("--candidate-report", ""))
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
    const app =
      options.config ??
      (yield* loadEvaluationApp(line.value("--config", "eval.config.ts"), args))
    const extension = app.commands[line.command]
    if (extension) {
      const result = yield* extension(line.args)
      output(result)
      return typeof result === "number" ? result : 0
    }
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
      yield* validateEvaluationApp(app)
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
    const directory = resolve(
      line.value("--directory", `.eval-results/runs/${randomUUID()}`)
    )
    if (line.command === "export") {
      const run = yield* readRun(line.value("--report", ""))
      const selected = line.value("--exporter", "").split(",").filter(Boolean)
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
      })
      yield* writeJson(resolve(directory, "export-receipts.json"), receipts)
      output(receipts)
      return 0
    }
    if (line.command === "review") {
      const run = yield* readRun(line.value("--report", ""))
      const bundle = line.has("--import")
        ? yield* fileIo(() =>
            readFile(line.value("--import", ""), "utf8")
          ).pipe(
            Effect.flatMap((text) =>
              Schema.decodeUnknownEffect(Schema.fromJsonString(ReviewBundle))(
                text
              )
            ),
            Effect.mapError(
              (error) =>
                new EvaluationError({ code: "invalid", message: String(error) })
            ),
            Effect.flatMap((review) => approveReviews(run, review))
          )
        : reviewBundle(run)
      yield* Schema.encodeEffect(ReviewBundle)(bundle).pipe(
        Effect.mapError(
          (error) =>
            new EvaluationError({ code: "invalid", message: String(error) })
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
      const saved = yield* readRun(line.value("--from", ""))
      yield* requireFreshDirectory(directory)
      const run = yield* gradeEvaluation(app, saved, randomUUID(), {
        graders: line.value("--grader", "").split(",").filter(Boolean)
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
      tasks: line.value("--task", "").split(",").filter(Boolean),
      executeOnly: line.has("--execute-only"),
      candidates: line.value("--candidate", "").split(",").filter(Boolean),
      split: line.value(
        "--split",
        line.command === "calibrate" ? "calibration" : "validation"
      ),
      ...(line.has("--repetitions")
        ? { repetitions: Number(line.value("--repetitions", "1")) }
        : {}),
      ...(line.has("--concurrency")
        ? { concurrency: Number(line.value("--concurrency", "1")) }
        : {}),
      ...(line.has("--timeout-ms")
        ? { timeoutMs: Number(line.value("--timeout-ms", "60000")) }
        : {}),
      ...(line.has("--environment")
        ? { environment: line.value("--environment", "") }
        : {})
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
        ? calibrateGrader(app, line.ids[0] ?? "", randomUUID(), selection)
        : runEvaluation(app, randomUUID(), selection)
    ).pipe(
      Effect.provide(
        Layer.merge(
          EvaluationServicesLive(app),
          EvaluationRunStoreFsLive(directory)
        )
      )
    )
    const selectedExporters = line
      .value("--exporter", "")
      .split(",")
      .filter(Boolean)
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
    })
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
      gates: run.gates.map((gate) => ({
        ...gate,
        value: Option.getOrNull(gate.value)
      }))
    })
    return run.failures.length ||
      run.gates.some((gate) => gate.mode === "blocking" && !gate.passed)
      ? 2
      : 0
  })
