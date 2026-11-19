import { Schema } from "effect"
import { FilePath } from "../files/files.entity.js"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Place = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/**
 * What to find (ADR 0028): `pattern`, a text found as it is written, or with `regex` a JavaScript regular expression
 * (no flags: letter case counts); `folder`, the folder to look in (every file of the workspace when left out); `glob`,
 * the files to look at, matched against a file's name when it holds no `/` and against its path in the workspace when
 * it does, `*` and `?` within a name and `**` across folders; `limit`, the most matches to give.
 *
 * @public
 */
export const SearchQuery = Schema.Struct({
  pattern: Schema.String,
  regex: Schema.optionalKey(Schema.Boolean),
  folder: Schema.optionalKey(FilePath),
  glob: Schema.optionalKey(Schema.String),
  limit: Place,
})
export type SearchQuery = typeof SearchQuery.Type

/**
 * One line that holds what was looked for: the file, the line's number (from 1), the column its first match starts at
 * (from 1, in UTF-16 code units, as a JavaScript string counts) and the line's text without its line end. A line longer
 * than `LINE_SHOWN` characters is shown as `LINE_SHOWN` of them around the match, never half a character: from
 * `LINE_BEFORE` before it, or the line's last `LINE_SHOWN` when the match is nearer its end.
 *
 * @public
 */
export const SearchMatch = Schema.Struct({ path: FilePath, line: Place, column: Place, text: Schema.String })
export type SearchMatch = typeof SearchMatch.Type

/**
 * What a search found: the matches, ordered by path in code-unit order then by line, at most the query's `limit`;
 * `more`, whether there were more; and `skipped`, how many files of those looked at could not be read as text (the
 * workspace declined them: not UTF-8, too large, kept from the agent) or were gone when read.
 *
 * @public
 */
export const Found = Schema.Struct({ matches: Schema.Array(SearchMatch), more: Schema.Boolean, skipped: Count })
export type Found = typeof Found.Type

/**
 * Why a pattern or a glob cannot be used: it is empty (`Empty`), holds a line break (`LineBreak`; a search matches one
 * line at a time), is longer than `PATTERN_LIMIT` (`TooLong`), is no regular expression the engine compiles
 * (`NotRegex`), repeats a group that holds a choice or a quantifier (`RepeatedGroup`: `(a|aa)+`, `(a+)+`, the forms
 * that can backtrack for exponential time; refused because the engine cannot be stopped once it runs), or is a regular
 * expression asked of a search its host keeps to text as it is written (`RegexOff`).
 *
 * @public
 */
export const PatternProblem = Schema.Literals(["Empty", "LineBreak", "TooLong", "NotRegex", "RepeatedGroup", "RegexOff"])
export type PatternProblem = typeof PatternProblem.Type

/**
 * The pattern or the glob (`of`) is not one the search can use, and why (`reason`); `message` says it in words, in the
 * engine's own for `NotRegex`, which differ between runtimes.
 *
 * @public
 */
export class PatternInvalid extends Schema.TaggedError<PatternInvalid>()("PatternInvalid", {
  of: Schema.Literals(["pattern", "glob"]),
  reason: PatternProblem,
  pattern: Schema.String,
  message: Schema.String,
}) {}

/**
 * The medium the search reads failed (the workspace's `FilesUnavailable`). A tool's call that meets it is a defect.
 *
 * @public
 */
export class SearchUnavailable extends Schema.TaggedError<SearchUnavailable>()("SearchUnavailable", {
  message: Schema.String,
}) {}

/**
 * The most characters of a matching line a match shows.
 *
 * @public
 */
export const LINE_SHOWN = 200

/**
 * How many characters before its match a long line is shown from.
 *
 * @public
 */
export const LINE_BEFORE = 40

/**
 * The most characters of a pattern.
 *
 * @public
 */
export const PATTERN_LIMIT = 1000

/**
 * The most matches one call of `searchFiles` gives.
 *
 * @public
 */
export const SEARCH_LIMIT = 50

/**
 * The name of the tool that searches the workspace.
 *
 * @public
 */
export const SEARCH_FILES = "searchFiles"
