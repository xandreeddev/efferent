import { Schema } from "effect"
import { SessionId } from "@xandreed/core"
import { ReviewStage } from "./review-tools.entity.js"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** The most model calls one pass makes by default. */
export const DEFAULT_MAX_STEPS = 16

/** The longest a pass's closing summary is kept, in characters. */
export const SUMMARY_KEPT = 600

/** What one model call of a pass used, as the provider reported it: tokens read (the cached share among them) and written. */
export const CallTokens = Schema.Struct({
  input: Count,
  cached: Count,
  output: Count,
})
export type CallTokens = typeof CallTokens.Type

/**
 * One model call of a pass: its step, the tokens it used (none when the provider did not report them) and what the
 * spend ledger settled for it.
 */
export const CallUsage = Schema.Struct({
  step: Count.check(Schema.isGreaterThanOrEqualTo(1)),
  tokens: Schema.OptionFromNullOr(CallTokens),
  cost: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type CallUsage = typeof CallUsage.Type

/**
 * How a pass ended: the model answered without a tool call (`Answered`, its one-line summary), a check gave its
 * verdict (`Judged`), or the pass stopped with the findings so far because it reached its step cap (`StepCap`, after
 * one more call that may only report, with what that call answered in words, and why it failed when it did), the
 * ledger refused a call (`SpendRefused`, also after one more such call), a call failed (`ModelFailed`, the failure's
 * words), an answer was cut at the output cap (`OutputCut`, after the calls it asked for ran), the pass's journal
 * could not be opened or written (`JournalFailed`, its words), or the pass could not run at all (`Failed`: the host's
 * failure in its words, its folder not made, a defect).
 */
export const PassEnded = Schema.Union([
  Schema.TaggedStruct("Answered", { summary: Schema.String }),
  Schema.TaggedStruct("Judged", {}),
  Schema.TaggedStruct("StepCap", { steps: Count, summary: Schema.String, why: Schema.String }),
  Schema.TaggedStruct("SpendRefused", { message: Schema.String }),
  Schema.TaggedStruct("ModelFailed", { message: Schema.String }),
  Schema.TaggedStruct("OutputCut", {}),
  Schema.TaggedStruct("JournalFailed", { message: Schema.String }),
  Schema.TaggedStruct("Failed", { message: Schema.String }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type PassEnded = typeof PassEnded.Type

/** Why a pass that did not answer is incomplete, in words for the report. */
export const INCOMPLETE_BECAUSE: Readonly<Record<Exclude<PassEnded["_tag"], "Answered" | "Judged">, string>> = {
  StepCap: "the pass reached its step cap",
  SpendRefused: "the spend cap refused a model call",
  ModelFailed: "a model call failed",
  OutputCut: "an answer was cut at the output cap",
  JournalFailed: "the pass's journal could not be kept",
  Failed: "the pass could not run",
}

/** The ends of a pass that finished its work: it answered, a check gave its verdict, or it reached its step cap. */
export const FINISHED: ReadonlyArray<PassEnded["_tag"]> = ["Answered", "Judged", "StepCap"]

/** A pass's journal could not be opened, read or written: what failed, in its words, and the failure. */
export class PassJournalFailed extends Schema.TaggedError<PassJournalFailed>()("PassJournalFailed", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * What a pass is asked: the most model calls it makes, and what it holds back from its stage, in USD, from its start
 * for its closing call (`reserve`, released just before that call), so a spend refusal mid-pass still leaves room to
 * report what it found.
 */
export const PassOptions = Schema.Struct({
  maxSteps: Count.check(Schema.isGreaterThanOrEqualTo(1)),
  reserve: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type PassOptions = typeof PassOptions.Type

/**
 * One pass or check of a review: its stage (the pass's or the check's number), the session its journal keeps it under
 * (none when the journal failed before one was made), how it ended, the model calls it made with what each used, and
 * the files it opened (each path given to `readLines` or `readDiff`, once, in code-unit order).
 */
export const PassResult = Schema.Struct({
  stage: ReviewStage,
  session: Schema.OptionFromNullOr(SessionId),
  ended: PassEnded,
  calls: Schema.Array(CallUsage),
  opened: Schema.Array(Schema.String),
})
export type PassResult = typeof PassResult.Type
