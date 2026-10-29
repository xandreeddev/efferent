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
