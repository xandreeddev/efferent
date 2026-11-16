// The part of lesson 13's page that runs the evals: it brings the eval
// package, which no other lesson's page carries, and is loaded only when
// "Run evals" is pressed (`Lesson.evals.load`). It runs every file again,
// apart from the page's program, as lesson 12's checks do: agent.ts is given
// the kernel's own parts, memory.ts's memory as the file made it, and the
// shown chat.ts with its types taken out. Then evals.ts, and runnable.ts as
// the page runs it (its types taken out by named pieces), with the names its
// imports list and the two the page gives: `models`, each candidate's model
// by its name, and `hear`, told of each trial as the run writes it. What the
// run makes and writes is untyped JavaScript, held to the package's own
// schemas before the page draws it.
import { Cause, Effect, Fiber, Layer, Option, Predicate, Queue, Result, Schema } from "effect"
import { LanguageModel } from "effect/ai"
import { kernel, Sessions } from "@xandreed/core/kernel"
import { inProcessJournal, sessions, turnsOf } from "@xandreed/sdk/kernel"
import {
  compareDecisionTrials,
  DecisionCaseId,
  DecisionTrial,
  defineRunnable,
  EvalId,
  EvaluationError,
  EvaluationRun,
  EvaluationRunStore,
  EvaluationServicesLive,
  evaluationEnvironmentPort,
  EvidenceProjector,
  graderFromEvaluator,
  gradingContext,
  runEvaluation,
  runnableExecutionPort,
  tasksFromDataset,
  Trial,
  TrialRecorder,
} from "@xandreed/evals"
import { buildFailure, named, programOf, runStatements, textOf } from "../../evaluate.ts"
import type { Sources } from "../../lesson.ts"
import { loadEcho } from "../../models/mock.ts"
import type { LoadedModel } from "../../models/types.ts"
import { CHAT, chatBodyOf } from "../test-your-agent/chat.source.ts"
import { chatNames, madeOn, NO_PANE } from "../test-your-agent/lesson.ts"
import { EvalsBoard } from "./board.ts"
import type { Compared, EvalsView } from "./board.ts"
import { evalsMade, withReadOnly } from "./lesson.ts"
import { RUNNABLE, runnableBodyOf } from "./runnable.source.ts"

/** The weaker candidate's name: an Echo that calls no tool, and answers every message in words. */
export const NO_TOOLS = "echo-no-tools"

/** The baseline's name: Echo, the reference solution, which passes every task of the starter's dataset. */
export const BASELINE = "echo"

/** One candidate against Echo, as the board draws it: what `compareDecisionTrials` gives, the fields read. */
const ComparedRow = Schema.Struct({ candidate: Schema.String, attempts: Schema.Number, successes: Schema.Number, infrastructure: Schema.Number, regressions: Schema.Array(Schema.String) })

/** What the run gives: each candidate's run, and the comparison. */
const Outcome = Schema.Struct({ runs: Schema.Array(EvaluationRun), comparison: Schema.Array(ComparedRow) })

/**
 * The models compared, by name, each as it was loaded and not as the page watches it, so the page hears no prompt of
 * a trial: Echo, the weaker Echo, and the model picked when it is not Echo. Echo comes first, as the baseline.
 */
export const modelsFor = (picked: LoadedModel): ReadonlyArray<readonly [string, Layer.Layer<LanguageModel.LanguageModel>]> => {
  const of = (loaded: LoadedModel) => Layer.succeed(LanguageModel.LanguageModel, loaded.model)
  const echo = picked.choice.id === BASELINE ? picked : loadEcho()
  return [
    [BASELINE, of(echo)],
    [NO_TOOLS, of(loadEcho(undefined, NO_TOOLS, "words"))],
    ...(picked.choice.id === BASELINE ? [] : [[picked.choice.id, of(picked)] as const]),
  ]
}

/** What runnable.ts imports, but the page's two names and what the other files made. */
const runnableNames = {
  Effect, Fiber, Layer, Option, Queue, Schema, kernel, Sessions, inProcessJournal, sessions, turnsOf,
  compareDecisionTrials, DecisionCaseId, defineRunnable, EvalId, EvaluationError, EvaluationRunStore, EvaluationServicesLive,
  evaluationEnvironmentPort, EvidenceProjector, graderFromEvaluator, gradingContext, runEvaluation, runnableExecutionPort,
  tasksFromDataset, TrialRecorder,
}

/** A run of the evals, ready: the board it fills, and the run itself, which ends with the board's last view. */
export interface EvalsRun {
  readonly board: EvalsBoard
  readonly run: Effect.Effect<EvalsView>
}

/**
 * The evals of the files as they stand, on the models `modelsFor` gives for the model picked, or why a file did not
 * run, in words that name it. `changed` is told the board's view each time a trial is written, and once the run is
 * over, however it ended. The run never fails: a run the package refused, or one that failed, says so on the board,
 * and a run that was stopped is interrupted and says so too; what it finished stays shown.
 */
export const evalsOf = (sources: Sources, picked: LoadedModel, changed: (view: EvalsView) => void): Result.Result<EvalsRun, string> =>
  Result.flatMap(runStatements("chat.ts did not run: ", chatBodyOf(CHAT), "{ Chat, chatOn }", chatNames), (chat) => {
    const models = modelsFor(picked)
    const stack = { kernel, inProcessJournal, sessions, Chat: named(chat, "Chat"), chatOn: named(chat, "chatOn"), pane: NO_PANE, model: models[0]?.[1] }
    return Result.flatMap(madeOn(withReadOnly(sources), stack, (memory) => memory), ({ flatMemory, toolsLive, program }) => {
      if (!Effect.isEffect(program)) return Result.fail("agent.ts did not run: program is not an Effect. It should be the program main runs, exported so that runnable.ts runs the same one.")
      return Result.flatMap(evalsMade(sources.evals ?? ""), (made) => {
        // The board's rows are runnable.ts's, which it makes below: until then, no trial is a row.
        let rowOf: (trial: Trial) => Option.Option<DecisionTrial> = () => Option.none()
        const board = new EvalsBoard(models.map(([name]) => name), made.tasks, made.repetitions, (trial) => rowOf(trial))
        const hear = (written: unknown) => {
          if (!Schema.is(Trial)(written)) return
          board.hear(written)
          changed(board.view())
        }
        const names = {
          ...runnableNames, program, Chat: stack.Chat, chatOn: stack.chatOn, flatMemory, toolsLive,
          dataset: made.dataset, evaluators: made.evaluators, repetitions: made.repetitions, gates: made.gates,
          models: Object.fromEntries(models), hear,
        }
        return Result.flatMap(runStatements("runnable.ts did not run: ", runnableBodyOf(RUNNABLE), "{ evaluation, rowOf }", names), (ran) => {
          const row = named(ran, "rowOf")
          if (!Predicate.isFunction(row)) return Result.fail("runnable.ts did not run: rowOf is not a function.")
          rowOf = (trial) => {
            const made: unknown = Reflect.apply(row, undefined, [trial])
            return Schema.is(DecisionTrial)(made) ? Option.some(made) : Option.none()
          }
          return Result.mapBoth(programOf(named(ran, "evaluation")), {
            onFailure: () => "runnable.ts did not run: evaluation is not an Effect.",
            onSuccess: (evaluation) => ({
              board,
              run: evaluation.pipe(
                Effect.matchCauseEffect({
                  onSuccess: (outcome) => Effect.sync(() => {
                    if (!Schema.is(Outcome)(outcome)) return board.failed("the run gave no runs and comparison the page can read.")
                    const compared: ReadonlyArray<Compared> = outcome.comparison
                    board.done(outcome.runs, compared)
                  }),
                  // A run that was stopped is interrupted, and says so; any other failure is said in its own words.
                  onFailure: (cause) => Effect.sync(() => Cause.hasInterruptsOnly(cause)
                    ? board.stopped()
                    : board.failed(Option.match(Cause.findErrorOption(cause), { onNone: () => buildFailure(cause), onSome: textOf }))),
                }),
                Effect.onInterrupt(() => Effect.sync(() => board.stopped())),
                // Every ending is drawn: done, failed, or stopped.
                Effect.ensuring(Effect.sync(() => changed(board.view()))),
                Effect.map(() => board.view()),
              ),
            }),
          })
        })
      })
    })
  })

/**
 * What "Run evals" hands `runtime.runAlone`: given the model picked, the run of the files as they stand, or why there
 * is none, in words. `changed` is told the board's view as the table fills, and once more when the run is over.
 */
export const startEvals = (sources: Sources, changed: (view: EvalsView) => void) =>
  (model: Option.Option<LoadedModel>): Promise<Result.Result<Effect.Effect<EvalsView>, string>> =>
    Promise.resolve(Option.match(model, {
      onNone: () => Result.fail("Pick a model first."),
      onSome: (picked) => Result.map(evalsOf(sources, picked, changed), (made) => {
        changed(made.board.view())
        return made.run
      }),
    }))
