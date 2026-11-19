import { Context } from "effect"
import type { Effect, Option } from "effect"
import type { CheckNumber, Finding, FindingReport, PassNumber, Verdict, VerdictReport } from "./finding.entity.js"

/**
 * Where a review keeps what its passes report and what its checks conclude: `record` keeps one report of a pass and
 * answers its number in that pass, from 1; `all` answers every finding kept, in the order they were reported;
 * `judge` keeps a check's verdict (a check's first verdict stands, and a later one answers false); `verdictOf` answers
 * a check's verdict, if it gave one.
 */
export class Findings extends Context.Service<Findings, {
  readonly record: (pass: PassNumber, report: FindingReport) => Effect.Effect<number>
  readonly all: Effect.Effect<ReadonlyArray<Finding>>
  readonly judge: (check: CheckNumber, report: VerdictReport) => Effect.Effect<boolean>
  readonly verdictOf: (check: CheckNumber) => Effect.Effect<Option.Option<Verdict>>
}>()("@xandreed/review/Findings") {}
