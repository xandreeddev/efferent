import { Cause, Exit, Formatter, Option, Predicate, Result } from "effect"
import type { TurnEnding } from "./sessions.entity.js"

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
 * A typed error as a stored failure: its own `code` and message when it has
 * a string `code` (a `HarnessError`, a `SessionLogError`); `turn.failed`
 * otherwise, with `<_tag>: <message>` for a tagged error.
 */
const failureOfError = (error: unknown): { readonly code: string; readonly message: string } => Option.match(stringField(error, "code"), {
  onSome: (code) => ({ code, message: Option.getOrElse(stringField(error, "message"), () => Formatter.format(error)) }),
  onNone: () => ({
    code: "turn.failed",
    message: Option.match(stringField(error, "_tag"), {
      onSome: (tag) => `${tag}: ${Option.getOrElse(Option.filter(stringField(error, "message"), (text) => text.length > 0), () => fieldsOf(error))}`,
      onNone: () => typeof error === "string" ? error : Formatter.format(error),
    }),
  }),
})

const failed = (failure: { readonly code: string; readonly message: string }): TurnEnding =>
  ({ reason: "failed", failure: Option.some({ code: failure.code, message: clipped(failure.message) }) })

/**
 * How a turn ended, from its exit:
 * - success: the outcome it returned, with no failure;
 * - a typed error (it wins over an interruption in the same cause): failed,
 *   with the error's own `code` and message when it has a string `code`, and
 *   `turn.failed` with `<_tag>: <message>` (or the error as text) otherwise;
 * - a defect: failed, `turn.defect` (a runner applies
 *   `harnessDefectsAsFailures` before taking the exit, so a `HarnessError`
 *   carried as a defect keeps its own code);
 * - an interruption only: interrupted, `turn.interrupted`.
 * Messages are cut to 500 characters. A runner whose exit has no outcome
 * maps it first: `turnEndingOf(Exit.map(exit, () => ({ outcome: "completed" })))`.
 */
export const turnEndingOf = (exit: Exit.Exit<{ readonly outcome: "completed" | "partial" | "failed" }, unknown>): TurnEnding => Exit.match(exit, {
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
