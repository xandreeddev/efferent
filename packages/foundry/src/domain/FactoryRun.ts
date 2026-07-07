import { Schema } from "effect"
import { AttemptNumber, RunId, WorkspacePath } from "./Brands.js"
import { Spec } from "./Spec.js"
import { GateReport } from "./Verdict.js"

export class AttemptRecord extends Schema.Class<AttemptRecord>("AttemptRecord")({
  attempt: AttemptNumber,
  report: GateReport,
  /** The brief fed into the NEXT attempt; `None` on an accepted/final attempt. */
  feedback: Schema.optionalWith(Schema.NonEmptyString, { as: "Option" }),
  filesTouched: Schema.Array(WorkspacePath),
  durationMs: Schema.NonNegative,
}) {}

/**
 * How the run ended. A rejected run is a RESULT, not an error — the report
 * is the deliverable; only infrastructure failures ride the error channel.
 */
export const AcceptedOutcome = Schema.TaggedStruct("accepted", { attempt: AttemptNumber })
export const RejectedOutcome = Schema.TaggedStruct("rejected", {
  reason: Schema.Literal("attempts-exhausted", "budget-exhausted"),
})
export const RunOutcome = Schema.Union(AcceptedOutcome, RejectedOutcome)
export type RunOutcome = typeof RunOutcome.Type

/** The durable, self-describing artifact one `forge` produces. */
export class FactoryRun extends Schema.Class<FactoryRun>("FactoryRun")({
  id: RunId,
  spec: Spec,
  attempts: Schema.NonEmptyArray(AttemptRecord),
  outcome: RunOutcome,
  /** Epoch millis, from `Clock`. */
  startedAt: Schema.NonNegative,
  endedAt: Schema.NonNegative,
}) {}
