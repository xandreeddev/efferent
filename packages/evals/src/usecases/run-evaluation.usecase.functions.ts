import { Cause, Clock, Effect, Exit, Option, Ref, Semaphore } from "effect"
import type {
  EvaluationApp,
  EvaluationSelection,
  GradingSelection
} from "../contracts/evaluation-app.contract.js"
import { validateEvaluationApp } from "../contracts/evaluation-app.contract.functions.js"
import { EvaluationError, EvalId } from "../domain/identity.entity.js"
import type { Trial } from "../domain/trial.entity.js"
import type { Grade } from "../domain/grader.entity.js"
import type { Suite } from "../domain/suite.entity.js"
import type { Task } from "../domain/task.entity.js"
import type { Candidate } from "../domain/candidate.entity.js"
import type { EvaluationRun } from "../domain/evaluation-run.entity.js"
import { runGates } from "../domain/evaluation-run.entity.functions.js"
import { EvaluationRunStore } from "../ports/evaluation-store.port.js"
import { EvaluationServices } from "../ports/evaluation-services.port.js"
import { TrialExecution } from "../ports/trial-execution.port.js"
import { EvidenceProjector } from "../ports/evidence-projector.port.js"
import { GraderAssessment } from "../ports/grader-assessment.port.js"
import type { TrialRecorder } from "../ports/trial-recorder.port.js"
import { unknownEvaluationUsage } from "../assessment.usecase.functions.js"
import { validateMetrics } from "../assessment.entity.functions.js"
import { fingerprint } from "../domain/grading-context.entity.functions.js"

export const gradeTrial = (
  app: EvaluationApp,
  trial: Trial,
  onSettled: (trial: Trial) => Effect.Effect<void> = () => Effect.void,
  timeoutMs = 60_000
) =>
  Effect.gen(function* () {
    const store = yield* EvaluationRunStore
    const services = yield* EvaluationServices
    return yield* Effect.reduce(
      trial.task.graders,
      () => trial,
      (current, binding) =>
        Effect.gen(function* () {
          const startedAt = yield* Clock.currentTimeMillis
          const grader = app.graders.find(
            (entry) =>
              `${entry.definition.id}@${entry.definition.version}` ===
              binding.grader
          )
          const projection = app.projections.find(
            (entry) => entry.definition.id === binding.projection
          )
          if (!grader || !projection)
            return yield* Effect.fail(
              new EvaluationError({
                code: "invalid",
                message: `Missing grader or projection for ${binding.grader}`
              })
            )
          const context = yield* Effect.scoped(
            Effect.gen(function* () {
              const context = yield* services.projection(binding.projection)
              return yield* EvidenceProjector.use((port) =>
                port.project(current, current.task, binding.scope)
              ).pipe(Effect.provide(context))
            })
          ).pipe(
            Effect.timeoutOrElse({
              duration: timeoutMs,
              orElse: () =>
                Effect.fail(
                  new EvaluationError({
                    code: "timeout",
                    message: "Projection deadline exceeded"
                  })
                )
            }),
            Effect.exit
          )
          const assessed = Exit.isSuccess(context)
            ? yield* Effect.scoped(
                Effect.gen(function* () {
                  const contextServices = yield* services.grading(
                    binding.grader
                  )
                  return yield* GraderAssessment.use((port) =>
                    port.assess(context.value, current.candidate)
                  ).pipe(Effect.provide(contextServices))
                })
              ).pipe(
                Effect.tap((grade) =>
                  grade.status === "scored"
                    ? validateMetrics(
                        grade.metrics,
                        grader.definition.metrics
                      ).pipe(
                        Effect.mapError(
                          (error) =>
                            new EvaluationError({
                              code: "invalid",
                              message: error.message
                            })
                        )
                      )
                    : Effect.void
                ),
                Effect.timeoutOrElse({
                  duration: timeoutMs,
                  orElse: () =>
                    Effect.fail(
                      new EvaluationError({
                        code: "timeout",
                        message: "Grader deadline exceeded"
                      })
                    )
                }),
                Effect.exit
              )
            : Exit.failCause(context.cause)
          if (
            Exit.isFailure(assessed) &&
            Cause.hasInterruptsOnly(assessed.cause)
          )
            return yield* Effect.failCause(assessed.cause)
          const grade: Grade = Exit.isSuccess(assessed)
            ? {
                ...assessed.value,
                grader: grader.definition.id,
                version: grader.definition.version,
                scope: binding.scope,
                context: Exit.isSuccess(context)
                  ? Option.some(context.value)
                  : Option.none(),
                startedAt,
                endedAt: yield* Clock.currentTimeMillis
              }
            : {
                grader: grader.definition.id,
                version: grader.definition.version,
                scope: binding.scope,
                status: Cause.findErrorOption(assessed.cause).pipe(
                  Option.exists((error) => error.code === "unavailable")
                )
                  ? "unavailable"
                  : "error",
                metrics: [],
                reason: Cause.pretty(assessed.cause),
                context: Exit.isSuccess(context)
                  ? Option.some(context.value)
                  : Option.none(),
                usage: unknownEvaluationUsage,
                startedAt,
                endedAt: yield* Clock.currentTimeMillis,
                metadata: {}
              }
          const settled = { ...current, grades: [...current.grades, grade] }
          yield* Effect.uninterruptible(
            store.writeTrial(settled).pipe(Effect.andThen(onSettled(settled)))
          )
          return settled
        })
    )
  })

const runTrial = (
  app: EvaluationApp,
  runId: string,
  suite: Suite,
  task: Task,
  candidate: Candidate,
  sample: number,
  selection: EvaluationSelection
) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const store = yield* EvaluationRunStore
      const startedAt = yield* Clock.currentTimeMillis
      const initial: Trial = {
        version: 1,
        id: EvalId.make(
          `${runId}/${suite.id}/${candidate.id}/${task.id}/${sample}`
        ),
        runId: EvalId.make(runId),
        suiteId: suite.id,
        task,
        candidate,
        sample,
        status: "running",
        startedAt,
        endedAt: startedAt,
        output: Option.none(),
        evidence: Option.none(),
        outcome: Option.none(),
        transcript: [],
        reason: "",
        grades: []
      }
      const state = yield* Ref.make(initial)
      const writer = yield* Semaphore.make(1)
      yield* store.writeTrial(initial)
      const recorder: TrialRecorder["Service"] = {
        record: (kind, data) =>
          Effect.uninterruptible(
            writer.withPermits(1)(
              Effect.gen(function* () {
                const current = yield* Ref.get(state)
                if (current.status !== "running") return
                const at = yield* Clock.currentTimeMillis
                const updated = yield* Ref.updateAndGet(state, (trial) => ({
                  ...trial,
                  transcript: [
                    ...trial.transcript,
                    {
                      id: EvalId.make(
                        `${trial.id}/event/${trial.transcript.length}`
                      ),
                      sequence: trial.transcript.length,
                      at,
                      kind,
                      data
                    }
                  ]
                }))
                yield* store.writeTrial(updated)
              })
            )
          )
      }
      const runnable = app.runnables.find(
        (entry) => entry.definition.id === task.runnable
      )
      const environment = runnable?.environments.find(
        (entry) =>
          entry.id ===
          (selection.environment ?? app.environmentFor[task.runnable])
      )
      const services = yield* EvaluationServices
      const execution = yield* restore(
        Effect.scoped(
          Effect.gen(function* () {
            if (!runnable || !environment)
              return yield* Effect.fail(
                new EvaluationError({
                  code: "invalid",
                  message: `No runnable/environment for ${task.runnable}`
                })
              )
            const context = yield* services.execution(
              task.runnable,
              environment.id,
              recorder
            )
            return yield* Effect.gen(function* () {
              const runner = yield* TrialExecution
              return yield* runner.execute(task.input, candidate, {
                timeoutMs: suite.timeoutMs,
                record: (outcome) => Ref.update(state, (trial) => ({
                  ...trial,
                  outcome: Option.some(outcome)
                }))
              })
            }).pipe(Effect.provide(context))
          })
        ).pipe(
          Effect.timeoutOrElse({
            duration: suite.timeoutMs,
            orElse: () =>
              Effect.fail(
                new EvaluationError({
                  code: "timeout",
                  message: "Trial deadline exceeded"
                })
              )
          })
        )
      ).pipe(Effect.exit)
      return yield* writer.withPermits(1)(Effect.gen(function* () {
        const recorded = yield* Ref.get(state)
        const completed: Trial = {
          ...recorded,
          endedAt: yield* Clock.currentTimeMillis,
          status: Exit.isSuccess(execution)
            ? "completed"
            : Cause.hasInterruptsOnly(execution.cause)
              ? "cancelled"
              : "error",
          output: Exit.isSuccess(execution)
            ? Option.some(execution.value.output)
            : Option.none(),
          evidence: Exit.isSuccess(execution)
            ? Option.some(execution.value.evidence)
            : Option.none(),
          reason: Exit.isSuccess(execution) ? "" : Cause.pretty(execution.cause)
        }
        yield* Ref.set(state, completed)
        yield* store.writeTrial(completed)
        return completed
      }))
    })
  )

/** Identifies captured execution independently of grader revisions and their reports. */
export const executionFingerprint = (run: EvaluationRun) =>
  fingerprint({
    application: run.application,
    trials: run.trials.map(
      ({
        suiteId,
        task,
        candidate,
        sample,
        status,
        output,
        evidence,
        outcome,
        transcript
      }) => ({
        suiteId,
        input: task.input,
        reference: task.reference,
        task: task.id,
        dataset: task.datasetVersion,
        candidate,
        sample,
        status,
        output,
        evidence,
        outcome,
        transcript
      })
    )
  })

/** Regrades captured work. This use case never opens an environment or invokes a runnable. */
export const gradeEvaluation = (
  app: EvaluationApp,
  source: EvaluationRun,
  runId: string,
  selection: GradingSelection = {}
): Effect.Effect<
  EvaluationRun,
  EvaluationError,
  EvaluationRunStore | EvaluationServices
> =>
  Effect.gen(function* () {
    yield* validateEvaluationApp(app)
    if (source.application !== app.id)
      return yield* Effect.fail(
        new EvaluationError({
          code: "invalid",
          message: "Captured execution belongs to a different application"
        })
      )
    const allSuites = app.suites.concat(
      app.calibrations.map((entry) => entry.suite)
    )
    const suites = allSuites
      .filter((suite) =>
        source.trials.some((trial) => trial.suiteId === suite.id)
      )
      .map((suite) => ({
        ...suite,
        candidates: source.trials
          .filter((trial) => trial.suiteId === suite.id)
          .map((trial) => trial.candidate)
          .filter(
            (candidate, index, entries) =>
              entries.findIndex((entry) => entry.id === candidate.id) === index
          )
      }))
    const requested = selection.graders ?? []
    const matches = (grader: string) =>
      !requested.length ||
      requested.some((id) => grader === id || grader.split("@")[0] === id)
    if (
      source.trials.some(
        (trial) => !suites.some((suite) => suite.id === trial.suiteId)
      ) ||
      requested.some(
        (id) =>
          !allSuites.some((suite) =>
            suite.tasks.some((task) =>
              task.graders.some(
                (binding) =>
                  binding.grader === id || binding.grader.split("@")[0] === id
              )
            )
          )
      )
    )
      return yield* Effect.fail(
        new EvaluationError({
          code: "invalid",
          message: "Saved suite or selected grader is not registered"
        })
      )
    const startedAt = yield* Clock.currentTimeMillis
    const trials = yield* Effect.forEach(source.trials, (trial) =>
      Effect.gen(function* () {
        const suite = suites.find((entry) => entry.id === trial.suiteId)
        const configured = suite?.tasks.find(
          (entry) => entry.id === trial.task.id
        )
        if (!configured)
          return yield* Effect.fail(
            new EvaluationError({
              code: "invalid",
              message: `Saved task ${trial.task.id} is not registered`
            })
          )
        const revised: Trial = {
          ...trial,
          id: EvalId.make(
            `${runId}/${trial.suiteId}/${trial.candidate.id}/${trial.task.id}/${trial.sample}`
          ),
          runId: EvalId.make(runId),
          task: {
            ...trial.task,
            graders: configured.graders.filter((binding) =>
              matches(binding.grader)
            )
          },
          grades: []
        }
        return yield* gradeTrial(
          app,
          revised,
          () => Effect.void,
          suite!.timeoutMs
        )
      })
    )
    const run: EvaluationRun = {
      ...source,
      id: EvalId.make(runId),
      phase: "graded",
      startedAt,
      endedAt: yield* Clock.currentTimeMillis,
      trials,
      fingerprints: {
        ...source.fingerprints,
        gradingConfiguration: fingerprint({
          graders: app.graders.map((grader) => grader.definition),
          projections: app.projections.map(({ definition }) => definition)
        }),
        sourceRun: source.id,
        sourceExecution:
          source.fingerprints.sourceExecution ?? executionFingerprint(source)
      },
      gates: runGates(
        suites.map((suite) => ({
          ...suite,
          gates: suite.gates.filter((gate) => matches(gate.grader))
        })),
        trials
      ),
      failures: trials.flatMap((trial) => [
        ...(trial.status !== "completed"
          ? [`${trial.id}: ${trial.reason}`]
          : []),
        ...trial.grades
          .filter(
            (grade) =>
              grade.status === "error" || grade.status === "unavailable"
          )
          .map((grade) => `${trial.id}/${grade.grader}: ${grade.reason}`)
      ])
    }
    const store = yield* EvaluationRunStore
    yield* store.writeRun(run)
    return run
  })

export const runEvaluation = (
  app: EvaluationApp,
  runId: string,
  selection: EvaluationSelection
): Effect.Effect<
  EvaluationRun,
  EvaluationError,
  EvaluationRunStore | EvaluationServices
> =>
  Effect.gen(function* () {
    yield* validateEvaluationApp(app)
    if (
      (selection.concurrency !== undefined &&
        (!Number.isInteger(selection.concurrency) ||
          selection.concurrency < 1)) ||
      (selection.timeoutMs !== undefined &&
        (!Number.isFinite(selection.timeoutMs) || selection.timeoutMs <= 0))
    )
      return yield* Effect.fail(
        new EvaluationError({
          code: "invalid",
          message: "Concurrency and timeout must be positive"
        })
      )
    const suites = app.suites
      .filter(
        (suite) =>
          selection.ids.length === 0 || selection.ids.includes(suite.id)
      )
      .map((suite) => ({
        ...suite,
        concurrency: selection.concurrency ?? suite.concurrency,
        timeoutMs: selection.timeoutMs ?? suite.timeoutMs,
        candidates: suite.candidates.filter(
          (candidate) =>
            !selection.candidates?.length ||
            selection.candidates.includes(candidate.id)
        )
      }))
    if (
      !suites.length ||
      selection.ids.some((id) => !suites.some((suite) => suite.id === id))
    )
      return yield* Effect.fail(
        new EvaluationError({
          code: "invalid",
          message: "Unknown or empty suite selection"
        })
      )
    if (
      suites.some((suite) => !suite.candidates.length) ||
      selection.candidates?.some(
        (id) =>
          !suites.some((suite) =>
            suite.candidates.some((candidate) => candidate.id === id)
          )
      )
    )
      return yield* Effect.fail(
        new EvaluationError({
          code: "invalid",
          message: "Unknown or empty candidate selection"
        })
      )
    if (
      selection.tasks?.some(
        (id) =>
          !suites.some((suite) => suite.tasks.some((task) => task.id === id))
      )
    )
      return yield* Effect.fail(
        new EvaluationError({
          code: "invalid",
          message: "Unknown task selection"
        })
      )
    const startedAt = yield* Clock.currentTimeMillis
    const trials = yield* Effect.forEach(suites, (suite) => {
      const repetitions = selection.repetitions ?? suite.repetitions
      const cases = suite.tasks.filter(
        (task) =>
          (!selection.split ||
            selection.split === "all" ||
            task.split === selection.split) &&
          (!selection.tasks?.length || selection.tasks.includes(task.id))
      )
      if (!cases.length || !Number.isInteger(repetitions) || repetitions < 1)
        return Effect.fail(
          new EvaluationError({
            code: "invalid",
            message: "Empty split or invalid repetitions"
          })
        )
      return Effect.forEach(
        suite.candidates
          .filter(
            (candidate) =>
              !selection.candidates?.length ||
              selection.candidates.includes(candidate.id)
          )
          .flatMap((candidate) =>
            cases.flatMap((task) =>
              Array.from({ length: repetitions }, (_, index) => ({
                candidate,
                task,
                sample: index + 1
              }))
            )
          ),
        ({ task, candidate, sample }) =>
          runTrial(app, runId, suite, task, candidate, sample, selection),
        { concurrency: suite.concurrency }
      )
    })
    const settled = trials.flat()
    const run: EvaluationRun = {
      version: 1,
      id: EvalId.make(runId),
      application: app.id,
      phase: "executed",
      startedAt,
      endedAt: yield* Clock.currentTimeMillis,
      fingerprints: app.fingerprints,
      trials: settled,
      gates: [],
      failures: settled.flatMap((trial) =>
        trial.status !== "completed" ? [`${trial.id}: ${trial.reason}`] : []
      )
    }
    const store = yield* EvaluationRunStore
    yield* store.writeRun(run)
    return selection.executeOnly ? run : yield* gradeEvaluation(app, run, runId)
  })

export const calibrateGrader = (
  app: EvaluationApp,
  id: string,
  runId: string,
  selection: EvaluationSelection
) => {
  const calibration = app.calibrations.find((entry) => entry.id === id)
  return calibration
    ? runEvaluation(
        {
          ...app,
          suites: [calibration.suite],
          calibrations: app.calibrations.filter((entry) => entry.id !== calibration.id),
          fingerprints: {
            ...app.fingerprints,
            calibration: `${calibration.id}@${calibration.version}`,
            calibratedGrader: `${calibration.grader.id}@${calibration.grader.version}`,
            ...Object.fromEntries(
              Object.entries(calibration.grader.fingerprints).map(
                ([key, value]) => [`calibratedGrader:${key}`, value]
              )
            )
          }
        },
        runId,
        { ...selection, ids: [calibration.suite.id] }
      )
    : Effect.fail(
        new EvaluationError({
          code: "invalid",
          message: `Unknown calibration ${id}`
        })
      )
}
