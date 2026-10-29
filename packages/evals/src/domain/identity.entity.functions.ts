import { Cause, Option, Predicate } from "effect"

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
 * A failed trial's, grade's or assessment's reason, as text a report and an
 * export may hold: each error and defect as `code: message` when it has a
 * string `code` (an `EvaluationError`), `<_tag>: message` for another tagged
 * error, `<name>: message` for an `Error` subclass, its message alone
 * otherwise (as `Cause.prettyErrors` reads it), joined by "; ";
 * "interrupted" when the cause holds interruptions only. Never a stack
 * frame, so never the local paths in one.
 */
export const reasonOf = <E>(cause: Cause.Cause<E>): string => {
  if (Cause.hasInterruptsOnly(cause)) return "interrupted"
  const texts = cause.reasons.flatMap((reason) =>
    Cause.isFailReason(reason) ? [textOf(reason.error)] : Cause.isDieReason(reason) ? [textOf(reason.defect)] : [])
  return texts.length === 0 ? "failed without an error" : texts.join("; ")
}
