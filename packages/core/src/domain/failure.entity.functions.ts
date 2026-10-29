import { Cause, Option, Predicate } from "effect"
import type { Failure } from "./failure.entity.js"

/** Project an arbitrary defect into the model-readable failure shape. */
export const toFailure = (error: unknown): Failure =>
  error instanceof Error
    ? { error: error.name, message: error.message }
    : { error: "Error", message: String(error) }

const stringField = (value: unknown, key: string): Option.Option<string> =>
  Predicate.isObject(value) ? Option.filter(Option.some(value[key]), Predicate.isString) : Option.none()

/** An error's label: its `code`, else its `_tag`, else its class name unless that is plain `Error`. */
const labelOf = (value: unknown): Option.Option<string> => Option.firstSomeOf([
  stringField(value, "code"),
  stringField(value, "_tag"),
  Option.filter(stringField(value, "name"), (name) => name !== "Error"),
])

/** One error or defect as text, from its message alone (never its stack); a message that starts with its label keeps it once. */
const textOf = (value: unknown): string => {
  const message = Cause.prettyErrors(Cause.die(value))[0]?.message ?? ""
  return Option.match(labelOf(value), {
    onSome: (label) => message.length === 0 ? label : message.startsWith(`${label}:`) ? message : `${label}: ${message}`,
    onNone: () => message.length === 0 ? "Error" : message,
  })
}

/**
 * A cause as text a report, a stored record or a model may hold: each error
 * and defect as `code: message` when it has a string `code` (a
 * `HarnessError`), `<_tag>: message` for another tagged error, `<name>:
 * message` for an `Error` subclass, its message alone otherwise (as
 * `Cause.prettyErrors` reads it), joined by "; "; "interrupted" when the
 * cause holds interruptions only. Never a stack frame, so never the host
 * paths in one: log the cause itself (`Effect.logError(message, cause)`)
 * where its stack is wanted.
 */
export const reasonOf = <E>(cause: Cause.Cause<E>): string => {
  if (Cause.hasInterruptsOnly(cause)) return "interrupted"
  const texts = cause.reasons.flatMap((reason) =>
    Cause.isFailReason(reason) ? [textOf(reason.error)] : Cause.isDieReason(reason) ? [textOf(reason.defect)] : [])
  return texts.length === 0 ? "failed without an error" : texts.join("; ")
}
