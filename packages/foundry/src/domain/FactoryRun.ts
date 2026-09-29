import { Schema } from "effect"
import { AttemptNumber, RunId, WorkspacePath } from "./Brands.js"
import { Spec } from "./Spec.js"
import { GateReport } from "./Verdict.js"

export class AttemptRecord extends Schema.Class<AttemptRecord>("AttemptRecord")({
  attempt: AttemptNumber,
  report: GateReport,
  /** The brief fed into the NEXT attempt; `None` on an accepted/final attempt. */
  feedback: Schema.OptionFromOptional(Schema.NonEmptyString),
  filesTouched: Schema.Array(WorkspacePath),
  durationMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  /** The implementor's opaque provenance ref (e.g. `"conversation:<uuid>"`). */
  implementorRef: Schema.OptionFromOptional(Schema.NonEmptyString),
}) {}

/**
 * How the run ended. A rejected run is a RESULT, not an error — the report
 * is the deliverable; only infrastructure failures ride the error channel.
 * `in-flight` marks a mid-run upsert: the loop persists after EVERY attempt
 * (same run id, same file), so a killed run keeps its forensics and its
 * failed attempts still feed `deriveLessons`. A run that finishes overwrites
 * the marker with the real outcome; one that reads `in-flight` at rest was
 * interrupted.
 */
export const AcceptedOutcome = Schema.TaggedStruct("accepted", { attempt: AttemptNumber })
export const RejectedOutcome = Schema.TaggedStruct("rejected", {
  /** `stalled`: an attempt changed nothing and reproduced the previous
   *  attempt's exact findings — the loop stops rather than burning the
   *  remaining attempts on a verdict no retry can move. */
  reason: Schema.Literals(["attempts-exhausted", "budget-exhausted", "stalled"]),
})
export const InFlightOutcome = Schema.TaggedStruct("in-flight", {})
export const RunOutcome = Schema.Union([AcceptedOutcome, RejectedOutcome, InFlightOutcome])
export type RunOutcome = typeof RunOutcome.Type

/** The durable, self-describing artifact one `forge` produces. */
export class FactoryRun extends Schema.Class<FactoryRun>("FactoryRun")({
  id: RunId,
  spec: Spec,
  attempts: Schema.NonEmptyArray(AttemptRecord),
  outcome: RunOutcome,
  /** Epoch millis, from `Clock`. */
  startedAt: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  endedAt: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
}) {}
