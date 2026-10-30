import { Result } from "effect"
import type { Failure } from "@xandreed/core"
import type { FileSearch, SearchLine } from "./text-search.entity.js"
import { clipChars, splitLines } from "./text-window.entity.functions.js"

const failure = (error: string, message: string): Failure => ({ error, message })

/**
 * A regular expression's source as the tokens the repetition check reads:
 * an escape, a character class, a group's opening (with its `?:`, `?=`,
 * `?!`, `?<=`, `?<!` or `?<name>`), a closing parenthesis, a quantifier
 * (lazy or not), `|`, or one other character.
 */
const tokenPattern = /\\[\s\S]|\[(?:\\[\s\S]|[^\]\\])*\]|\((?:\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>))?|\)|\{\d+(?:,\d*)?\}\??|[*+?]\??|[\s\S]/g

/** Whether a quantifier token has no upper bound: `*`, `+`, `{n,}` (lazy or not). */
const unbounded = (token: string): boolean => token.startsWith("*") || token.startsWith("+") || /^\{\d+,\}/.test(token)
const isQuantifier = (token: string): boolean => /^(?:[*+?]|\{\d+(?:,\d*)?\})\??$/.test(token)

interface Scan {
  /** For each open group, outermost first, whether what it holds so far repeats without bound. */
  readonly groups: ReadonlyArray<boolean>
  /** Whether the token before is a group just closed whose content repeats without bound. */
  readonly closedRepeating: boolean
  readonly nested: boolean
}

/**
 * Whether a regular expression (one that compiles, without the `u` or `v`
 * flag) repeats without bound a group that itself holds an unbounded
 * repetition: `(a+)+`, `(x*)*`, `(?:\w+\s?)*`, `((ab)+)+`. Such patterns
 * backtrack exponentially on some lines. Repeating a group a bounded
 * number of times (`(\d+\.){3}`) is not counted.
 */
export const repeatsRepetition = (source: string): boolean =>
  (source.match(tokenPattern) ?? []).reduce<Scan>((scan, token) => {
    if (token.startsWith("(")) return { groups: [...scan.groups, false], closedRepeating: false, nested: scan.nested }
    if (token === ")") {
      const inner = scan.groups.at(-1) ?? false
      const outer = scan.groups.slice(0, -1)
      return { groups: outer.length === 0 ? [inner] : [...outer.slice(0, -1), (outer.at(-1) ?? false) || inner], closedRepeating: inner, nested: scan.nested }
    }
    if (isQuantifier(token) && unbounded(token)) {
      return { groups: [...scan.groups.slice(0, -1), true], closedRepeating: false, nested: scan.nested || scan.closedRepeating }
    }
    return { ...scan, closedRepeating: false }
  }, { groups: [false], closedRepeating: false, nested: false }).nested

/**
 * The expression `grep` matches with: the pattern as a JavaScript regular
 * expression, or, with `literal`, as plain text; `ignoreCase` ignores
 * case. Fails with `InvalidPattern` when the pattern does not compile, or
 * when it repeats a repeating group (`repeatsRepetition`): matching runs
 * in the host's process and cannot be interrupted, and such a pattern can
 * take exponential time on one line.
 */
export const compilePattern = (pattern: string, options: { readonly literal: boolean; readonly ignoreCase: boolean }): Result.Result<RegExp, Failure> => {
  const source = options.literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern
  const compiled = Result.try({
    try: () => new RegExp(source, options.ignoreCase ? "i" : ""),
    catch: (error) => failure("InvalidPattern", `${pattern} is not a valid regular expression; the engine says: ${error instanceof Error ? error.message : String(error)}. Pass literal: true to search for it as text`),
  })
  return Result.flatMap(compiled, (regex) => !options.literal && repeatsRepetition(source)
    ? Result.fail(failure("InvalidPattern", `${pattern} repeats a group that itself repeats (as in (a+)+), which can take exponential time on some lines; rewrite it without the nested repetition, or search with bash (grep -E, rg)`))
    : Result.succeed(regex))
}

/**
 * Search a file's text line by line. Each line is cut to `lineChars`
 * characters first and only the cut line is matched (a match past the cut
 * is not found), so how long a line may take is bounded by the cut, not by
 * the line. That bound holds for patterns that match in linear time: the
 * expression runs synchronously in the host's process, and a backtracking
 * one can still take long on a cut line. `compilePattern` refuses nested
 * repetition, the usual exponential form, but not every slow pattern
 * (overlapping alternatives such as `(a|a)*`). At most `cap` matching lines
 * are taken, each with up to `context` lines before and after it;
 * overlapping context is shown once, in line order.
 */
export const searchText = (text: string, pattern: RegExp, options: { readonly lineChars: number; readonly context: number; readonly cap: number }): FileSearch => {
  const lines = splitLines(text).map((line) => clipChars(line, options.lineChars).text)
  const hits = lines.reduce<{ readonly found: ReadonlyArray<number>; readonly capped: boolean }>((state, line, at) =>
    state.capped ? state
      : !pattern.test(line) ? state
      : state.found.length >= options.cap ? { found: state.found, capped: true }
      : { found: [...state.found, at], capped: false }, { found: [], capped: false })
  const shown = new Set(hits.found.flatMap((at) => Array.from({ length: options.context * 2 + 1 }, (_, offset) => at - options.context + offset)
    .filter((line) => line >= 0 && line < lines.length)))
  const matched = new Set(hits.found)
  return {
    lines: [...shown].sort((left, right) => left - right).map((at): SearchLine => ({ line: at + 1, text: lines[at] ?? "", match: matched.has(at) })),
    matches: hits.found.length,
    capped: hits.capped,
  }
}

/**
 * The model's view of matches: `path:line:text` for a matching line,
 * `path-line-text` for context, and, when there is context, `--` between
 * runs of lines that are not adjacent (or not in one file).
 */
export const renderSearchLines = (
  lines: ReadonlyArray<{ readonly path: string; readonly line: number; readonly text: string; readonly match: boolean }>,
  withContext: boolean,
): ReadonlyArray<string> =>
  lines.flatMap((entry, at) => {
    const previous = lines[at - 1]
    const gap = withContext && previous !== undefined && (previous.path !== entry.path || previous.line + 1 !== entry.line)
    return [...(gap ? ["--"] : []), `${entry.path}${entry.match ? ":" : "-"}${entry.line}${entry.match ? ":" : "-"}${entry.text}`]
  })
