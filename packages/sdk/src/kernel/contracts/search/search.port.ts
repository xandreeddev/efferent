import { Context } from "effect"
import type { Effect } from "effect"
import type { Found, PatternInvalid, SearchQuery, SearchUnavailable } from "./search.entity.js"

/**
 * Search of the workspace (ADR 0028): `find(query)` gives the lines of the workspace's files that hold a text or match
 * a JavaScript regular expression, in a fixed order (path in code-unit order, then line), at most the query's `limit`,
 * and says whether there were more. A pattern the search cannot use fails with `PatternInvalid`; a file it cannot
 * read as text is passed over and counted. The kernel's adapter, `filesSearch`, reads the workspace through `Files`
 * and holds no index; like `Files`, only a tool's handler holds it among the agent's parts.
 *
 * @public
 */
export class Search extends Context.Service<Search, {
  readonly find: (query: SearchQuery) => Effect.Effect<Found, PatternInvalid | SearchUnavailable>
}>()("@xandreed/sdk/kernel/Search") {}
