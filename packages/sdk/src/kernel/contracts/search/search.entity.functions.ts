import { Result } from "effect"
import type { FilePath } from "../files/files.entity.js"
import { LINE_BEFORE, LINE_SHOWN, PATTERN_LIMIT, PatternInvalid, SEARCH_FILES } from "./search.entity.js"
import type { PatternProblem, SearchMatch, SearchQuery } from "./search.entity.js"

/** Where in a line a search finds its first match, or -1 for none. */
export type Finder = (line: string) => number

const refused = (of: "pattern" | "glob", reason: PatternProblem, pattern: string, message: string) => new PatternInvalid({ of, reason, pattern, message })

/**
 * How a query finds a match in a line: the pattern as it is written (`indexOf`), or with `regex` a JavaScript regular
 * expression compiled once, with no flags; or why it cannot: empty, more than one line, longer than `PATTERN_LIMIT`,
 * or no regular expression the engine compiles (in the engine's words, which differ between runtimes).
 */
export const finderOf = (query: Pick<SearchQuery, "pattern" | "regex">): Result.Result<Finder, PatternInvalid> => {
  const { pattern } = query
  if (pattern.length === 0) return Result.fail(refused("pattern", "Empty", pattern, "the pattern is empty"))
  if (/[\n\r]/.test(pattern)) return Result.fail(refused("pattern", "LineBreak", pattern, "the pattern holds a line break: a search matches one line at a time"))
  if (pattern.length > PATTERN_LIMIT) return Result.fail(refused("pattern", "TooLong", pattern, `the pattern is ${pattern.length} characters long, more than ${PATTERN_LIMIT}`))
  if (query.regex !== true) return Result.succeed((line) => line.indexOf(pattern))
  return Result.flatMap(
    Result.try({ try: () => new RegExp(pattern), catch: (cause) => refused("pattern", "NotRegex", pattern, cause instanceof Error ? cause.message : "it does not compile") }),
    (compiled): Result.Result<Finder, PatternInvalid> => repeatsChoice(pattern)
      ? Result.fail(refused("pattern", "RepeatedGroup", pattern, "the pattern repeats a group that holds a choice or a repetition, which can take exponential time on some lines"))
      : Result.succeed((line) => compiled.exec(line)?.index ?? -1),
  )
}

/** A regular expression's source as tokens: an escape, a class, a group's opening (with `?:`, a look-around or a name), `)`, a quantifier, or one character. */
const TOKENS = /\\[\s\S]|\[(?:\\[\s\S]|[^\]\\])*\]|\((?:\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>))?|\)|\{\d+(?:,\d*)?\}\??|[*+?]\??|[\s\S]/g

/** Whether a quantifier lets what it follows repeat: `*`, `+`, `{n,}`, and `{n}` or `{n,m}` past 1 (lazy or not); never `?`. */
const repeats = (token: string): boolean => {
  if (token.startsWith("*") || token.startsWith("+")) return true
  const bound = /^\{(\d+)(,(\d*))?\}/.exec(token)
  if (bound === null) return false
  const most = bound[2] === undefined ? Number(bound[1]) : bound[3] === "" ? Infinity : Number(bound[3])
  return most > 1
}
const isQuantifier = (token: string): boolean => /^(?:[*+?]|\{\d+(?:,\d*)?\})\??$/.test(token)

/**
 * Whether a regular expression repeats (`*`, `+`, `{n,}`, `{n,m}` past 1) a group that holds a choice (`|`) or a
 * quantifier of any kind: `(a+)+`, `(a|aa)+`, `(a|a)*`, `(\w+\s?)*`, `(x+x+)+`, `((ab)+)+`, `(\d+\.){3}`. Those
 * are the forms whose matches can be split many ways, which a backtracking engine may try one by one, for time
 * exponential in a line's length. A group with neither, repeated (`(ab)+`), a choice not repeated (`foo|bar`) and a
 * quantifier outside any repeated group (`\d+-\d+`, `a{2,4}`) pass. Not every slow pattern is caught: `a*a*a*$` takes
 * time polynomial in the line, and a host that cannot afford a miss turns regular expressions off (`filesSearch({
 * regex: false })`).
 */
export const repeatsChoice = (source: string): boolean => {
  // For each open group, outermost first, whether it holds a choice or a quantifier so far.
  const open: Array<boolean> = [false]
  let closedHolds = false
  for (const token of source.match(TOKENS) ?? []) {
    if (token.startsWith("(")) {
      open.push(false)
      closedHolds = false
    } else if (token === ")") {
      const inner = open.pop() ?? false
      if (open.length === 0) open.push(false)
      closedHolds = inner
    } else if (token === "|") {
      open[open.length - 1] = true
      closedHolds = false
    } else if (isQuantifier(token)) {
      if (closedHolds && repeats(token)) return true
      open[open.length - 1] = true
      closedHolds = false
    } else {
      closedHolds = false
    }
  }
  return false
}

/** A glob's text as a regular expression's: `**` across folders, `*` and `?` within a name, every other character as it is. */
const globSource = (glob: string): string => {
  let source = ""
  for (let at = 0; at < glob.length; at += 1) {
    const char = glob[at] ?? ""
    if (glob.startsWith("**/", at)) { source += "(?:[^/]*/)*"; at += 2 }
    else if (glob.startsWith("**", at)) { source += ".*"; at += 1 }
    else if (char === "*") source += "[^/]*"
    else if (char === "?") source += "[^/]"
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return source
}

/**
 * Which paths a glob keeps: one with no `/` is matched against a path's last name (`*.ts`), one with a `/` against the
 * whole path in the workspace (`src/**`); none, or an empty one, keeps every path.
 */
export const globOf = (glob: string | undefined): Result.Result<(path: FilePath) => boolean, PatternInvalid> => {
  if (glob === undefined || glob.length === 0) return Result.succeed(() => true)
  if (glob.length > PATTERN_LIMIT) return Result.fail(refused("glob", "TooLong", glob, `the glob is ${glob.length} characters long, more than ${PATTERN_LIMIT}`))
  const whole = new RegExp(`^${globSource(glob)}$`)
  return Result.succeed(glob.includes("/") ? (path) => whole.test(path) : (path) => whole.test(path.slice(path.lastIndexOf("/") + 1)))
}

/** A long line as a match shows it: `LINE_SHOWN` characters from `LINE_BEFORE` before the match, never half a character. */
export const shownLine = (line: string, at: number): string => {
  if (line.length <= LINE_SHOWN) return line
  let start = Math.max(0, Math.min(at - LINE_BEFORE, line.length - LINE_SHOWN))
  if (start > 0 && (line.charCodeAt(start) & 0xfc00) === 0xdc00) start -= 1
  let end = Math.min(line.length, start + LINE_SHOWN)
  if (end < line.length && (line.charCodeAt(end - 1) & 0xfc00) === 0xd800) end -= 1
  return line.slice(start, end)
}

/** The lines of a file's text that hold a match, in order: a line ends at `\n`, and a `\r` before it is not its text. */
export const matchesIn = (path: FilePath, text: string, find: Finder): ReadonlyArray<SearchMatch> => {
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines.flatMap((raw, index) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    const at = find(line)
    return at < 0 ? [] : [{ path, line: index + 1, column: at + 1, text: shownLine(line, at) }]
  })
}

/** A model's text as a failure repeats it: its start, and how much was left out. */
const shown = (text: string, limit: number): string => {
  if (text.length <= limit) return JSON.stringify(text)
  const end = (text.charCodeAt(limit - 1) & 0xfc00) === 0xd800 ? limit - 1 : limit
  return `${JSON.stringify(text.slice(0, end))} [… ${text.length - end} characters clipped]`
}

/** What `searchFiles` answers for each reason a pattern cannot be used, in fixed words (an engine's own differ by runtime). */
const PATTERN_WORDS: Record<PatternProblem, (pattern: string) => string> = {
  Empty: () => "The pattern is empty: give the text to find.",
  LineBreak: (pattern) => `The pattern ${shown(pattern, 80)} holds a line break, and a search matches one line at a time: search for one line of it.`,
  TooLong: (pattern) => `The pattern is ${pattern.length} characters long, and a search takes at most ${PATTERN_LIMIT}: search for a shorter part of it.`,
  NotRegex: (pattern) => `The pattern ${shown(pattern, 80)} is not a JavaScript regular expression. Fix it, or call ${SEARCH_FILES} with regex left out to find the text as it is written.`,
  RepeatedGroup: (pattern) => `The pattern ${shown(pattern, 80)} repeats a group that holds a choice or a repetition (as in (a|b)+ or (a+)+), which can take exponential time on some lines: write it without repeating such a group, or search for a plainer part of it.`,
  RegexOff: () => `This workspace's search finds text as it is written, not regular expressions: call ${SEARCH_FILES} again with regex left out.`,
}

/** What `searchFiles` answers for a pattern or a glob it cannot use. */
export const patternRefused = (error: PatternInvalid): string =>
  error.of === "glob"
    ? `The glob is ${error.pattern.length} characters long, and a search takes at most ${PATTERN_LIMIT}: give a shorter one, such as *.ts or src/**.`
    : PATTERN_WORDS[error.reason](error.pattern)
