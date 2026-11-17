// The part of lesson 19's page that checks the graders: it brings the eval
// package, which no other lesson's page carries, and is loaded only when
// "Check the graders" is pressed (`Lesson.calibration.start`). It runs
// labels.ts and graders.ts again, graders.ts with the package's own
// `SemanticJudge`, then calibration.ts as the page runs it (its types taken
// out by named pieces), with the names its imports list and the two the page
// gives: `evaluate`, the judge's transport (the real Jev with an AI Gateway
// key kept, the stand-in without one), and `hear`, told of each check as the
// run writes it. Nothing of the chat's program runs, and the page hears no
// trace of a check.
import { Cause, Effect, Layer, Option, Predicate, Result, Schema } from "effect"
import {
  calibrateGrader,
  CalibrationObservation,
  defineEvaluationApp,
  defineGraderCalibration,
  EvalId,
  EvaluationRunStore,
  EvaluationServicesLive,
  graderFromEvaluator,
  SemanticJevLive,
  SemanticJudge,
  Trial,
} from "@xandreed/evals"
import type { SemanticJevOptions } from "@xandreed/evals"
import { buildFailure, named, programOf, runStatements, textOf } from "../../evaluate.ts"
import type { Sources } from "../../lesson.ts"
import { DEFAULT_DECISION_MODEL, gatewayDecider } from "../../models/decide.ts"
import type { Fetch } from "../../models/gateway.ts"
import type { LoadedModel } from "../../models/types.ts"
import { GradersBoard, Row } from "./board.ts"
import type { GradersView } from "./board.ts"
import { CALIBRATION, calibrationBodyOf } from "./calibration.source.ts"
import { jevTransport } from "./jev.ts"
import { gradersMade, labelsMade } from "./lesson.ts"
import { RECORDED_ON, STARTER_REQUESTS, standIn } from "./stand-in.ts"

/** What a press costs with a key, in words. */
export const COST = `With a key, a press with the starter's files sends Jev ${STARTER_REQUESTS} requests, and costs less than a tenth of a cent.`

/** The line under the table when the stand-in answered. */
export const STAND_IN_LINE = `The stand-in answered for Jev: Jev's own answers to the starter's ${STARTER_REQUESTS} requests, recorded on ${RECORDED_ON}, each the middle of five runs. Keep an AI Gateway key in the model list, and the real Jev answers. ${COST}`

/** The line under the table when the real Jev was asked: a cell whose request failed says so in its reason. */
export const JEV_LINE = `Jev was asked, through the AI Gateway with your key. ${COST}`

/** Who answers for Jev: its transport, and the line the table says it under. */
export interface Judge {
  readonly evaluate: SemanticJevOptions["evaluate"]
  readonly line: string
}

/**
 * The judge for a press: with a key kept (`keyOf`, read at each request), the real Jev through the gateway, over
 * `fetchFn`; without one, the stand-in. A test gives both, so no test reaches the gateway.
 */
export const judgeOf = (keyOf: () => Option.Option<string>, fetchFn?: Fetch): Judge =>
  Option.match(keyOf(), {
    onNone: () => ({ evaluate: standIn, line: STAND_IN_LINE }),
    onSome: () => ({ evaluate: jevTransport(fetchFn === undefined ? gatewayDecider(keyOf) : gatewayDecider(keyOf, DEFAULT_DECISION_MODEL, fetchFn)), line: JEV_LINE }),
  })

/** What graders.ts imports, with the package's own judge. */
const gradersNames = { Effect, SemanticJudge }

/** What calibration.ts imports, but the page's two names and what the other files made. */
const calibrationNames = {
  Effect, Layer, Option, Schema,
  calibrateGrader, CalibrationObservation, defineEvaluationApp, defineGraderCalibration, EvalId, EvaluationRunStore,
  EvaluationServicesLive, graderFromEvaluator, SemanticJevLive,
}

/** A check of the graders, ready: the board it fills, and the run, which ends with the board's last view. */
export interface CheckRun {
  readonly board: GradersBoard
  readonly run: Effect.Effect<GradersView>
}

/**
 * The check of the files as they stand, with `judge` answering for Jev, or why a file did not run, in words that name
 * it. `changed` is told the board's view each time a check is written, and once the run is over, however it ended.
 * The run never fails: a run the package refused, or one that failed, says so on the board, and a run that was stopped
 * is interrupted and says so too; the checks it finished stay shown.
 */
export const checkOf = (sources: Sources, judge: Judge, changed: (view: GradersView) => void): Result.Result<CheckRun, string> =>
  Result.flatMap(labelsMade(sources.labels ?? ""), (labels) =>
    Result.flatMap(gradersMade(sources.graders ?? "", gradersNames), (graders) => {
      // The board's rows are calibration.ts's, which it makes below: until then, no check is a row.
      let rowOf: (written: unknown) => Option.Option<Row> = () => Option.none()
      const board = new GradersBoard(graders.ids, labels.cases, judge.line, (written) => rowOf(written))
      const hear = (written: unknown) => {
        if (!Schema.is(Trial)(written)) return
        board.hear(written)
        changed(board.view())
      }
      const names = { ...calibrationNames, labels: labels.labels, graders: graders.graders, evaluate: judge.evaluate, hear }
      return Result.flatMap(runStatements("calibration.ts did not run: ", calibrationBodyOf(CALIBRATION), "{ checked, rowOf }", names), (ran) => {
        const row = named(ran, "rowOf")
        if (!Predicate.isFunction(row)) return Result.fail("calibration.ts did not run: rowOf is not a function.")
        rowOf = (written) => {
          const made: unknown = Reflect.apply(row, undefined, [written])
          return Option.isOption(made) ? Option.flatMap(made, Schema.decodeUnknownOption(Row)) : Option.none()
        }
        return Result.mapBoth(programOf(named(ran, "checked")), {
          onFailure: () => "calibration.ts did not run: checked is not an Effect.",
          onSuccess: (checked) => ({
            board,
            run: checked.pipe(
              Effect.matchCauseEffect({
                onSuccess: () => Effect.sync(() => board.done()),
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
    }))

/**
 * What "Check the graders" hands `runtime.runAlone`: the check of the files as they stand, or why there is none, in
 * words. It needs no model: the graders are checked against the labels, and the chat's model answers nothing here.
 * `keyOf` gives the gateway key, read when the button is pressed and at each request; `fetchFn` is for tests.
 * `changed` is told the board's view as the table fills, and once more when the run is over.
 */
export const startCheck = (sources: Sources, changed: (view: GradersView) => void, keyOf: () => Option.Option<string>, fetchFn?: Fetch) =>
  (_model: Option.Option<LoadedModel>): Promise<Result.Result<Effect.Effect<GradersView>, string>> =>
    Promise.resolve(Result.map(checkOf(sources, judgeOf(keyOf, fetchFn), changed), (made) => {
      changed(made.board.view())
      return made.run
    }))
