import { Context } from "effect"
import type { Effect } from "effect"
import type { Finding, FindingReport, PassNumber } from "./finding.entity.js"

/**
 * Where a review keeps what its passes report: `record` keeps one report of a pass and answers its number in that
 * pass, from 1; `all` answers every finding kept, in the order they were reported.
 */
export class Findings extends Context.Service<Findings, {
  readonly record: (pass: PassNumber, report: FindingReport) => Effect.Effect<number>
  readonly all: Effect.Effect<ReadonlyArray<Finding>>
}>()("@xandreed/review/Findings") {}
