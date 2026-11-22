import { Schema } from "effect"
import { SessionId } from "@xandreed/core"
import { ReviewStage } from "./review-tools.entity.js"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** The most model calls (steps) one turn makes by default. */
export const DEFAULT_MAX_STEPS = 16

/** The longest a turn's closing summary is kept, in characters. */
export const SUMMARY_KEPT = 600

/** The most calls a closing ask makes: one, and one more when the tool refused a reporting call of the first. */
export const CLOSING_ASKS = 2

/**
 * The failed result a call gets, in place of running, once the turn's next request would pass its model's read limit
 * (`KernelTurnsOptions.readTokens`), by stage: a finder turn is told to report and answer, a check to give its verdict,
 * so it reads no more. Its answers still add to later requests, so a request may still grow past the limit by them.
 */
export const CONTEXT_FULL = {
  Find: "Not run: this turn has read as much as one request can hold. Report each defect you found with reportFinding now, then answer with a one-line summary.",
  Verify: "Not run: this check has read as much as one request can hold. Give your verdict with the verdict tool now, quoting the lines it rests on.",
} as const

/** Characters of a stored result counted as one token when the next request's size is estimated: fewer than code averages, so the estimate runs high. */
export const CHARS_PER_TOKEN = 3

/** What one model call of a turn used, as the provider reported it: tokens read (the cached share among them) and written. */
export const CallTokens = Schema.Struct({
  input: Count,
  cached: Count,
  output: Count,
})
export type CallTokens = typeof CallTokens.Type

/**
 * One model call of a turn: its step, the tokens it used (none when the provider did not report them) and what the
 * spend ledger settled for it.
 */
export const CallUsage = Schema.Struct({
  step: Count.check(Schema.isGreaterThanOrEqualTo(1)),
  tokens: Schema.OptionFromNullOr(CallTokens),
  cost: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type CallUsage = typeof CallUsage.Type

/**
 * How a turn ended: the model answered without a tool call (`Answered`, its one-line summary), a check gave its
 * verdict (`Judged`), or the turn stopped with the findings so far because it reached its step cap (`StepCap`, after
 * one more call that may only report, with what that call answered in words, and why it failed when it did), the
 * ledger refused a call (`SpendRefused`, also after one more such call), a call failed (`ModelFailed`, the failure's
 * words), an answer was cut at the output cap (`OutputCut`, after the calls it asked for ran), the turn's journal
 * could not be opened or written (`JournalFailed`, its words), or the turn could not run at all (`Failed`: the host's
 * failure in its words, its folder not made, a defect).
 */
export const TurnEnded = Schema.Union([
  Schema.TaggedStruct("Answered", { summary: Schema.String }),
  Schema.TaggedStruct("Judged", {}),
  Schema.TaggedStruct("StepCap", { steps: Count, summary: Schema.String, why: Schema.String }),
  Schema.TaggedStruct("SpendRefused", { message: Schema.String }),
  Schema.TaggedStruct("ModelFailed", { message: Schema.String }),
  Schema.TaggedStruct("OutputCut", {}),
  Schema.TaggedStruct("JournalFailed", { message: Schema.String }),
  Schema.TaggedStruct("Failed", { message: Schema.String }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type TurnEnded = typeof TurnEnded.Type

/** Why a turn that did not answer is incomplete, in words for the report. */
export const INCOMPLETE_BECAUSE: Readonly<Record<Exclude<TurnEnded["_tag"], "Answered" | "Judged">, string>> = {
  StepCap: "the turn reached its step cap",
  SpendRefused: "the spend cap refused a model call",
  ModelFailed: "a model call failed",
  OutputCut: "an answer was cut at the output cap",
  JournalFailed: "the turn's journal could not be kept",
  Failed: "the turn could not run",
}

/** The ends of a turn that finished its work: it answered, a check gave its verdict, or it reached its step cap. */
export const FINISHED: ReadonlyArray<TurnEnded["_tag"]> = ["Answered", "Judged", "StepCap"]

/** A turn's journal could not be opened, read or written: what failed, in its words, and the failure. */
export class TurnJournalFailed extends Schema.TaggedError<TurnJournalFailed>()("TurnJournalFailed", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * What a turn is asked: the most model calls (steps) it makes, and what it holds back from its stage, in USD, from its
 * start for its closing call (`reserve`, released just before that call), so a spend refusal mid-turn still leaves room
 * to report what it found.
 */
export const TurnOptions = Schema.Struct({
  maxSteps: Count.check(Schema.isGreaterThanOrEqualTo(1)),
  reserve: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type TurnOptions = typeof TurnOptions.Type

/**
 * One turn of a review, a finder's or a check's: its stage (the finder turn's or the check's number), the session its
 * journal keeps it under (none when the journal failed before one was made), how it ended, the model calls it made with
 * what each used, and the files it opened (each path given to `readLines` or `readDiff`, once, in code-unit order).
 */
export const TurnResult = Schema.Struct({
  stage: ReviewStage,
  session: Schema.OptionFromNullOr(SessionId),
  ended: TurnEnded,
  calls: Schema.Array(CallUsage),
  opened: Schema.Array(Schema.String),
})
export type TurnResult = typeof TurnResult.Type
