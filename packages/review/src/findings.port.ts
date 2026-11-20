import { Context } from "effect"
import type { Effect, Option } from "effect"
import type { CheckNumber, Finding, FindingReport, TurnNumber, Verdict, VerdictReport } from "./finding.entity.js"

/**
 * Where reviews keep what their finder turns report and what their checks conclude, each under its run (`run`, the
 * run's name, unique to one run of a review), so a store a host reuses never hands one run another's: `record` keeps
 * one report of a turn and answers its number in that turn, from 1; `all` answers every finding of the run, in the
 * order they were reported; `judge` keeps a check's verdict (a check's first verdict stands, and a later one answers
 * false); `verdictOf` answers a check's verdict, if it gave one.
 */
export class Findings extends Context.Service<Findings, {
  readonly record: (run: string, turn: TurnNumber, report: FindingReport) => Effect.Effect<number>
  readonly all: (run: string) => Effect.Effect<ReadonlyArray<Finding>>
  readonly judge: (run: string, check: CheckNumber, report: VerdictReport) => Effect.Effect<boolean>
  readonly verdictOf: (run: string, check: CheckNumber) => Effect.Effect<Option.Option<Verdict>>
}>()("@xandreed/review/Findings") {}
