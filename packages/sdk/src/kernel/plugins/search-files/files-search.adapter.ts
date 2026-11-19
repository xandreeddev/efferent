import { Effect, Layer, Option } from "effect"
import { Files } from "../../contracts/files/files.port.js"
import { PatternInvalid, SearchUnavailable } from "../../contracts/search/search.entity.js"
import type { Found, SearchMatch } from "../../contracts/search/search.entity.js"
import { finderOf, globOf, matchesIn } from "../../contracts/search/search.entity.functions.js"
import { Search } from "../../contracts/search/search.port.js"
import type { FilesSearchOptions } from "./files-search.entity.js"

/**
 * Search over the workspace's `Files` (ADR 0028), with no index and no runtime module, so it runs in a page as on a
 * disk. With `regex: false` (`FilesSearchOptions`) a query that asks for a regular expression is refused (`RegexOff`)
 * and text is found only as written: the folder's files are listed (in code-unit order, so the matches come in the contract's order), those the glob
 * keeps are read one at a time, each line tested, until one match past the limit says there are more. A file the
 * workspace will not give as text (`FilesRefused`: not UTF-8, too large, declined) or that went away since the listing
 * (`FileNotFound`) is passed over and counted; the medium's failure is `SearchUnavailable`.
 *
 * A regular expression runs on the JavaScript engine of the process, which nothing can stop once it runs: the forms
 * known to backtrack for exponential time are refused (`RepeatedGroup`), and a pattern that check misses holds the
 * search, and the process with it (ADR 0028). A host that cannot afford that turns regular expressions off. It reads every file it keeps
 * whole: what bounds that is the workspace's own bound on a file (`diskFiles`'s `maxBytes`).
 *
 * @public
 */
export const filesSearch = (options: FilesSearchOptions = {}): Layer.Layer<Search, never, Files> => Layer.effect(Search, Effect.gen(function* () {
  const files = yield* Files
  return Search.of({
    find: Effect.fn("files_search.find")(function* (query) {
      if (query.regex === true && options.regex === false) {
        return yield* Effect.fail(new PatternInvalid({ of: "pattern", reason: "RegexOff", pattern: query.pattern, message: "this search finds text as it is written, not regular expressions" }))
      }
      const find = yield* Effect.fromResult(finderOf(query))
      const keeps = yield* Effect.fromResult(globOf(query.glob))
      const unavailable = (error: { readonly message: string }) => new SearchUnavailable({ message: error.message })
      const paths = (yield* Effect.mapError(files.list(Option.fromNullishOr(query.folder)), unavailable)).filter(keeps)
      const found: Array<SearchMatch> = []
      let skipped = 0
      for (const path of paths) {
        if (found.length > query.limit) break
        const text = yield* files.read(path).pipe(
          Effect.map(Option.some),
          Effect.catchTags({
            FileNotFound: () => Effect.succeed(Option.none<string>()),
            FilesRefused: () => Effect.succeed(Option.none<string>()),
            FilesUnavailable: (error) => Effect.fail(unavailable(error)),
          }),
        )
        if (Option.isSome(text)) found.push(...matchesIn(path, text.value, find))
        else skipped += 1
      }
      const answer: Found = { matches: found.slice(0, query.limit), more: found.length > query.limit, skipped }
      return answer
    }),
  })
}))
