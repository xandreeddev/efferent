/**
 * How `filesSearch` searches (ADR 0028). `regex`: whether a query may ask for a JavaScript regular expression, true by
 * default. A regular expression runs on the process's own engine, which nothing can stop once it runs: the search
 * refuses the forms known to take exponential time (`RepeatedGroup`), and a pattern that check misses can hold the
 * search and the whole process. A host that cannot afford that sets `regex: false`: every query asking for one then
 * fails with `PatternInvalid` (`RegexOff`), which `searchFiles` says in fixed words, and text is found as written.
 *
 * @public
 */
export interface FilesSearchOptions {
  readonly regex?: boolean
}
