import { Effect, Match, Option, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { workspaceFolder } from "../../contracts/files/files.entity.functions.js"
import { Found, LINE_BEFORE, LINE_SHOWN, SEARCH_FILES, SEARCH_LIMIT } from "../../contracts/search/search.entity.js"
import type { PatternInvalid, SearchUnavailable } from "../../contracts/search/search.entity.js"
import { patternRefused } from "../../contracts/search/search.entity.functions.js"
import { Search } from "../../contracts/search/search.port.js"

/**
 * The tool that searches the files of the workspace (ADR 0028), through the `Search` the host provides (`filesSearch`
 * over its `Files`).
 *
 * @public
 */
export const SearchFiles = Tool.make(SEARCH_FILES, {
  description: `Find a text in the files of the workspace, or of one folder. Returns \`matches\`, each a line that holds it: its \`path\`, its \`line\` number, the \`column\` the text starts at and the line's \`text\` (a line longer than ${LINE_SHOWN} characters is shown as ${LINE_SHOWN} of them, from ${LINE_BEFORE} before the match), by path and then line; at most ${SEARCH_LIMIT}, and \`more\` is true when there were more: give a folder or a glob to see them. \`skipped\` counts the files that could not be read as text.`,
  parameters: Schema.Struct({
    pattern: Schema.String.annotate({ description: "The text to find, on one line, as it is written; with regex, a JavaScript regular expression." }),
    regex: Schema.optionalKey(Schema.Boolean.annotate({ description: "True to read the pattern as a JavaScript regular expression, such as ^export (const|function). Left out, the text as it is written." })),
    folder: Schema.optionalKey(Schema.String.annotate({ description: "A folder in the workspace to search, such as src. Left out, the whole workspace." })),
    glob: Schema.optionalKey(Schema.String.annotate({ description: "Only files that match it: by name with no /, such as *.ts, or by path with one, such as src/**/*.ts; * and ? within a name, ** across folders." })),
  }),
  success: Found,
  failure: Schema.String,
  failureMode: "return",
  dependencies: [Search],
})

/**
 * The search's one tool: a host merges it into its own toolkit, `Toolkit.merge(tools, searchTools)`, which keeps its
 * type, so a program that leaves `Search` out does not compile where it calls it.
 *
 * @public
 */
export const searchTools = Toolkit.make(SearchFiles)

/** A failure of `Search` as the model reads it; the medium's own failure is a defect, as a store's is. */
const said = (error: PatternInvalid | SearchUnavailable): Effect.Effect<never, string> => Match.valueTags(error, {
  PatternInvalid: (invalid) => Effect.fail(patternRefused(invalid)),
  SearchUnavailable: (unavailable) => Effect.die(unavailable),
})

/**
 * What `searchFiles` does, over the `Search` the host provides, at most `SEARCH_LIMIT` matches a call. A folder that
 * is not one in the workspace and a pattern or a glob the search cannot use are failed results in fixed words; a
 * medium that fails is a defect.
 *
 * @public
 */
export const searchHandlers = searchTools.toLayer({
  searchFiles: ({ pattern, regex, folder, glob }) => Effect.gen(function* () {
    const search = yield* Search
    const within = yield* Effect.fromResult(workspaceFolder(folder))
    return yield* search.find({
      pattern,
      limit: SEARCH_LIMIT,
      ...(regex === undefined ? {} : { regex }),
      ...(glob === undefined ? {} : { glob }),
      ...Option.match(within, { onNone: () => ({}), onSome: (path) => ({ folder: path }) }),
    }).pipe(Effect.catch(said))
  }),
})
