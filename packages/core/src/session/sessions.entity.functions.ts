import { Cause, Exit, Formatter, Option, Predicate, Result, Schema } from "effect"
import type { TurnEndReason, TurnEnding, TurnFailure, TurnOrigin, TurnOutcomeKind } from "../domain/turn-vocabulary.entity.js"
import { harnessCodeOf } from "../harness/harness-code.entity.functions.js"
import { isHarnessError } from "../harness/plugin.entity.functions.js"
import { SessionLogError } from "./session-log.entity.js"
import { ReservedKind, SessionContended, TurnClosed } from "./sessions.entity.js"
import type { NotResumable, TurnError } from "./sessions.entity.js"

const taggedTurnErrors = [TurnClosed, ReservedKind, SessionContended, SessionLogError].map((error) => Schema.is(Schema.Struct(error.fields)))

/**
 * Whether a value is a `TurnError` (a `HarnessError`, `TurnClosed`,
 * `ReservedKind`, `SessionContended` or `SessionLogError`), by its tag and
 * fields, whichever copy of `@xandreed/core` made it: what
 * `harnessDefectsAsFailures` restores from a defect.
 */
export const isTurnError = (value: unknown): value is TurnError => isHarnessError(value) || taggedTurnErrors.some((is) => is(value))

/** The longest failure message a stored `turn.ended` keeps. */
const MESSAGE_CHARS = 500

const clipped = (text: string): string => text.length <= MESSAGE_CHARS ? text : text.slice(0, MESSAGE_CHARS)

const stringField = (value: unknown, key: string): Option.Option<string> =>
  Predicate.isObject(value) ? Option.filter(Option.some(value[key]), Predicate.isString) : Option.none()

/** An error's own fields as JSON, without its tag (for an error that has no message). */
const fieldsOf = (error: unknown): string => Predicate.isObject(error)
  ? Formatter.formatJson(Object.fromEntries(Object.entries(error).filter(([key]) => key !== "_tag")))
  : ""

/**
 * A failure's message: its own when it carries a string `code` (a
 * `HarnessError`, a `SessionLogError`); `<_tag>: <message>` for another
 * tagged error (its fields as JSON when it has no message); the error as
 * text otherwise.
 */
const messageOfError = (error: unknown): string => Option.isSome(stringField(error, "code"))
  ? Option.getOrElse(stringField(error, "message"), () => Formatter.format(error))
  : Option.match(stringField(error, "_tag"), {
    onSome: (tag) => `${tag}: ${Option.getOrElse(Option.filter(stringField(error, "message"), (text) => text.length > 0), () => fieldsOf(error))}`,
    onNone: () => typeof error === "string" ? error : Formatter.format(error),
  })

/** A typed error as a stored failure: its framework code (`harnessCodeOf`), else `turn.failed`, and its message. */
const failureOfError = (error: unknown): TurnFailure =>
  ({ code: Option.getOrElse(harnessCodeOf(error), () => "turn.failed"), message: messageOfError(error) })

const failed = (failure: TurnFailure): TurnEnding =>
  ({ reason: "failed", failure: Option.some({ code: failure.code, message: clipped(failure.message) }) })

/**
 * How a turn ended, from its exit:
 * - success: the outcome it returned, with no failure;
 * - a typed error (it wins over an interruption in the same cause): failed,
 *   with its code (`harnessCodeOf`: a `HarnessError`'s, the code a begin
 *   refusal, `TurnClosed` or `ReservedKind` stands for, a tagged error's own
 *   `code`), else `turn.failed`; its message when it carries a `code`, else
 *   `<_tag>: <message>` (or the error as text);
 * - a defect: failed, `turn.defect` (a runner applies
 *   `harnessDefectsAsFailures` before taking the exit, so a `TurnError`
 *   carried as a defect keeps its own code);
 * - an interruption only: interrupted, `turn.interrupted`.
 * Messages are cut to 500 characters. A runner whose exit has no outcome
 * maps it first: `turnEndingOf(Exit.map(exit, () => ({ outcome: "completed" })))`.
 */
export const turnEndingOf = (exit: Exit.Exit<{ readonly outcome: TurnOutcomeKind }, unknown>): TurnEnding => Exit.match(exit, {
  onSuccess: (value): TurnEnding => ({ reason: value.outcome, failure: Option.none() }),
  onFailure: (cause): TurnEnding => Option.match(Cause.findErrorOption(cause), {
    onSome: (error) => failed(failureOfError(error)),
    onNone: () => Result.match(Cause.findDefect(cause), {
      onSuccess: (defect) => failed({ code: "turn.defect", message: Formatter.format(defect) }),
      onFailure: () => Cause.hasInterrupts(cause)
        ? { reason: "interrupted", failure: Option.some({ code: "turn.interrupted", message: "the turn was interrupted" }) }
        : failed({ code: "turn.failed", message: "the turn failed without an error" }),
    }),
  }),
})

/**
 * One turn of a session as a resume is checked against it: who began it, the
 * turn it resumed (when it resumed one) and, once it ended, how.
 */
export interface ResumableTurn {
  readonly turn: number
  readonly origin: TurnOrigin
  readonly resumes: Option.Option<number>
  readonly ended: Option.Option<TurnEndReason>
}

const stopped = (ended: Option.Option<TurnEndReason>) => Option.exists(ended, (reason) => reason === "cancelled" || reason === "interrupted")

/**
 * A later user's turn supersedes `target`, unless it resumed `target` and
 * did not complete (it failed, was cancelled or was interrupted): such a
 * resume can be tried again, with a new key.
 */
const supersedes = (target: number) => (later: ResumableTurn) => later.turn > target && later.origin === "user"
  && !(Option.contains(later.resumes, target) && (stopped(later.ended) || Option.contains(later.ended, "failed")))

/**
 * Why turn `target` cannot be resumed, or none when it can, from the
 * session's own turns (each `turn.started`, with the turn it resumed and its
 * `turn.ended`'s reason when it has them): `missing` when no turn has that
 * number (a number that is not a whole number of at least 1 never does),
 * `inbox` or `task` when a turn a user did not begin has it (its origin),
 * `superseded` when a user's turn was
 * begun after it (only inbox turns, and resumes of it that failed, were
 * cancelled or were interrupted, may follow), `finished` unless it ended
 * cancelled or interrupted (a turn reaped because its holder stopped ended
 * interrupted; one with no end yet is open, which `SessionBusy` answers
 * first).
 */
export const resumeRefusal = (target: number, turns: ReadonlyArray<ResumableTurn>): Option.Option<NotResumable["reason"]> =>
  Option.match(Option.fromNullishOr(turns.find((candidate) => candidate.turn === target)), {
    onNone: () => Option.some("missing" as const),
    onSome: (found) => found.origin !== "user" ? Option.some(found.origin)
      : turns.some(supersedes(target)) ? Option.some("superseded" as const)
      : stopped(found.ended) ? Option.none()
      : Option.some("finished" as const),
  })
