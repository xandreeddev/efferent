import { Schema } from "effect"

/** One line of a file's search result: its 1-based number, its text (cut to the line width), and whether it matched or is context. */
export const SearchLine = Schema.Struct({
  line: Schema.Int,
  text: Schema.String,
  match: Schema.Boolean,
})
export type SearchLine = typeof SearchLine.Type

/**
 * One file searched: the lines to show (matches and their context, in
 * order), how many lines matched in what was searched, and whether the
 * search stopped at its cap with more of the file left.
 */
export const FileSearch = Schema.Struct({
  lines: Schema.Array(SearchLine),
  matches: Schema.Int,
  capped: Schema.Boolean,
})
export type FileSearch = typeof FileSearch.Type

/**
 * The lines of a file that matched, as the regular expression worker
 * answers them: the 0-based indices of at most `cap` matching lines, in
 * order, and whether a further line matched past the cap.
 */
export const LineHits = Schema.Struct({
  found: Schema.Array(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  capped: Schema.Boolean,
})
export type LineHits = typeof LineHits.Type
