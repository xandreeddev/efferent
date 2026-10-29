import { Schema } from "effect"

/**
 * Lines `lineWindow` picked from a text: `lines` are lines `firstLine` to
 * `lastLine` (1-based) of `totalLines`; `next` is the line to continue from
 * when some are left; `clipped` when the first line alone was longer than
 * the window's bytes and only its start is in `lines`.
 */
export const LineWindow = Schema.Struct({
  lines: Schema.Array(Schema.String),
  firstLine: Schema.Int,
  lastLine: Schema.Int,
  totalLines: Schema.Int,
  next: Schema.Option(Schema.Int),
  clipped: Schema.Boolean,
})
export type LineWindow = typeof LineWindow.Type

/** The lines `headLines` keeps from the start of a list, and how many it left out. */
export const HeadLines = Schema.Struct({
  lines: Schema.Array(Schema.String),
  omitted: Schema.Int,
})
export type HeadLines = typeof HeadLines.Type

/**
 * The end of a command's output `tailText` keeps: `text` is its last whole
 * lines within the limits (or, when the last line alone is longer than the
 * bytes allowed, the end of that line); `totalLines` counts the lines of the
 * whole output; `truncated` when anything was left out.
 */
export const OutputTail = Schema.Struct({
  text: Schema.String,
  shownLines: Schema.Int,
  totalLines: Schema.Int,
  truncated: Schema.Boolean,
})
export type OutputTail = typeof OutputTail.Type

/**
 * A file's bytes as text: the BOM, when there was one, removed and
 * remembered; `lossy` when the bytes were not valid UTF-8, so the sequences
 * that were not became U+FFFD and writing the text back would change them.
 */
export const DecodedText = Schema.Struct({
  text: Schema.String,
  bom: Schema.Boolean,
  lossy: Schema.Boolean,
})
export type DecodedText = typeof DecodedText.Type
