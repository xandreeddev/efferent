import { Schema } from "effect"

/**
 * How a text ends its lines: every break is `\r\n` (`crlf`), none has a
 * `\r` (`lf`), or both kinds appear (`mixed`, matched as it is).
 */
export const LineEnding = Schema.Literals(["lf", "crlf", "mixed"])
export type LineEnding = typeof LineEnding.Type

/**
 * Edits applied to a text: `text` is the new text, in the original's line
 * endings; `before` and `after` are the old and new text with `\n` line
 * breaks (what a diff compares); `replaced` counts the edits, `normalized`
 * says whether any was found only after normalising, and
 * `firstChangedLine` is the 1-based line of the first change.
 */
export const EditPlan = Schema.Struct({
  text: Schema.String,
  before: Schema.String,
  after: Schema.String,
  replaced: Schema.Int,
  normalized: Schema.Boolean,
  firstChangedLine: Schema.Int,
})
export type EditPlan = typeof EditPlan.Type

/** Where one edit applies in the original: the span `[start, end)` and what replaces it. */
export const EditSpan = Schema.Struct({
  index: Schema.Int,
  start: Schema.Int,
  end: Schema.Int,
  newText: Schema.String,
  normalized: Schema.Boolean,
})
export type EditSpan = typeof EditSpan.Type
