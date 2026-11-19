import { Array as Arr, Match, Option, Order, Result } from "effect"
import { clipTo } from "@xandreed/sdk"
import { GREP_TIMEOUT_MS } from "./checkout.entity.js"
import type { GrepHit, TreeEntry } from "./checkout.entity.js"
import type { FileDiff } from "./diff.entity.js"
import { renderDiff, shownPath } from "./diff.entity.functions.js"
import { DIFF_PAGE, GLOB_LIMIT, LINE_SHOWN, LIST_FILES, LIST_LIMIT, PATTERN_LIMIT, READ_DIFF, READ_LINES, SEARCH_CODE, SEARCH_LIMIT, SEARCH_LINE_SHOWN } from "./review-tools.entity.js"

/** Why a path that is in the tree is not read, in words that name what to do instead. */
export const NOT_READ_BECAUSE: Readonly<Record<Exclude<TreeEntry["_tag"], "File">, (shown: string) => string>> = {
  Link: (shown) => `${shown} is a symbolic link, which is not read: read the file it points to by its own path.`,
  Submodule: (shown) => `${shown} is a submodule, another repository, which is not read.`,
  Folder: (shown) => `${shown} is a folder: call ${LIST_FILES} with a glob such as ${shown}/** to see its files.`,
  Missing: (shown) => `There is no file ${shown} at the commit under review: call ${LIST_FILES} or ${SEARCH_CODE} to find the path.`,
}

/**
 * A path the model gave, as a path in the repository's tree, or why it is not one: relative to the root (a leading
 * `./` and trailing `/` are dropped), no `.` or `..` part, no part named `.git`, no NUL.
 */
export const treePath = (raw: string): Result.Result<string, string> => {
  const path = raw.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "")
  const parts = path.split("/")
  const refused = path.length === 0 || raw.startsWith("/") || path.includes("\u0000")
    || parts.some((part) => part.length === 0 || part === "." || part === ".." || part.toLowerCase() === ".git")
  return refused
    ? Result.fail(`${shownPath(raw)} is not a path in the repository: give one relative to its root, such as src/index.ts, with no .. part and no leading /.`)
    : Result.succeed(path)
}

/** A text's lines: split at line feeds, a carriage return before one dropped, no empty line after a last line feed. */
const linesOf = (text: string): ReadonlyArray<string> => {
  if (text.length === 0) return []
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""))
  return text.endsWith("\n") ? lines.slice(0, -1) : lines
}

/**
 * `count` lines of a file's text from line `from`, numbered (`  42| text`, each line clipped at `LINE_SHOWN` with a
 * count of what was left out), under a line naming the file, the lines shown and its total, and over a line saying
 * how to read on, or that the file ends there. A binary file, and a `from` past the end, are failures in words.
 */
export const linesPage = (path: string, text: string, from: number, count: number): Result.Result<string, string> => {
  const shown = shownPath(path)
  if (text.includes("\u0000")) return Result.fail(`${shown} is a binary file, which is not read.`)
  const lines = linesOf(text)
  const total = lines.length
  if (total === 0) return Result.succeed(`${shown} is empty.`)
  if (from > total) return Result.fail(`${shown} has ${total} lines: give from between 1 and ${total}.`)
  const last = Math.min(total, from + count - 1)
  const width = String(last).length
  const numbered = lines.slice(from - 1, last).map((line, at) => `${String(from + at).padStart(width)}| ${clipTo(line, LINE_SHOWN).replace("\n", " ")}`)
  const next = last < total ? `Lines ${last + 1} to ${total} follow: call ${READ_LINES} with from ${last + 1} to read on.` : "This is the end of the file."
  return Result.succeed([`${shown}: lines ${from} to ${last} of ${total}.`, ...numbered, next].join("\n"))
}

/** A pattern too long to search for, or an empty one: the failure in words; else none. */
export const patternRefusal = (pattern: string): Result.Result<string, string> =>
  pattern.length === 0 ? Result.fail("The pattern is empty: give the text to search for.")
    : pattern.length > PATTERN_LIMIT ? Result.fail(`The pattern has ${pattern.length} characters; give at most ${PATTERN_LIMIT}.`)
      : Result.succeed(pattern)

/**
 * What a search found, as the model reads it: how many lines hold the pattern (and where it looked), then at most
 * `SEARCH_LIMIT` of them as `path:line: text`, each cut at `SEARCH_LINE_SHOWN` characters with a count, then how
 * many more there are and how to narrow the search; or that no line holds it.
 */
export const searchText = (pattern: string, path: string | null, hits: ReadonlyArray<GrepHit>): string => {
  const where = path === null ? "" : ` in ${shownPath(path)}`
  const quoted = JSON.stringify(pattern)
  if (hits.length === 0) return `No line of a tracked file${where} holds ${quoted}.`
  const lines = hits.slice(0, SEARCH_LIMIT).map((hit) => clipTo(`${shownPath(hit.path)}:${hit.line}: ${hit.text.trim()}`, SEARCH_LINE_SHOWN).replace("\n", " "))
  const more = hits.length - SEARCH_LIMIT
  return [
    `${hits.length} ${hits.length === 1 ? "line holds" : "lines hold"} ${quoted}${where}${more > 0 ? `; the first ${SEARCH_LIMIT}` : ""}:`,
    ...lines,
    ...(more > 0 ? [`${more} more matches: narrow with path.`] : []),
  ].join("\n")
}

/** One step of a glob: a character, `?` (one character but `/`), `*` (any run without `/`), `**` (any run), or `**` then `/` (no folder, or any run that ends at a `/`). */
type GlobStep = { readonly _tag: "Char"; readonly char: string } | { readonly _tag: "One" } | { readonly _tag: "Star" } | { readonly _tag: "Any" } | { readonly _tag: "Folders" }

const globSteps = (glob: string): ReadonlyArray<GlobStep> => {
  const steps: Array<GlobStep> = []
  for (let at = 0; at < glob.length; at++) {
    const char = glob[at] ?? ""
    const double = char === "*" && glob[at + 1] === "*"
    const slash = double && glob[at + 2] === "/"
    steps.push(double ? (slash ? { _tag: "Folders" } : { _tag: "Any" }) : char === "*" ? { _tag: "Star" } : char === "?" ? { _tag: "One" } : { _tag: "Char", char })
    at += slash ? 2 : double ? 1 : 0
  }
  return steps
}

/** The places of `path` reached after one step, from the places reached before it: one pass over the path. */
const stepped = (path: string, reached: ReadonlyArray<boolean>, step: GlobStep): ReadonlyArray<boolean> => {
  const next: Array<boolean> = reached.map(() => false)
  const one = (accepts: (char: string) => boolean) => {
    for (let at = 0; at < path.length; at++) if (reached[at] === true && accepts(path[at] ?? "")) next[at + 1] = true
  }
  const run = (stopsAtSlash: boolean) => {
    let open = false
    for (let at = 0; at < reached.length; at++) {
      open = open || reached[at] === true
      if (open) next[at] = true
      if (stopsAtSlash && path[at] === "/") open = false
    }
  }
  Match.valueTags(step, {
    Char: ({ char }) => one((found) => found === char),
    One: () => one((found) => found !== "/"),
    Star: () => run(true),
    Any: () => run(false),
    Folders: () => {
      let open = false
      for (let at = 0; at < reached.length; at++) {
        if (reached[at] === true || (open && at > 0 && path[at - 1] === "/")) next[at] = true
        open = open || reached[at] === true
      }
    },
  })
  return next
}

/**
 * Whether a path matches a glob: `*` any run of characters but `/`, `**` any run, `**` then `/` any folders or none,
 * `?` one character but `/`; everything else itself; a leading `./` or `/` dropped. Matched over the set of places
 * reached, step by step, each step one pass over the path, so no glob can take long.
 */
export const globMatches = (glob: string, path: string): boolean => {
  const start: ReadonlyArray<boolean> = Array.from({ length: path.length + 1 }, (_, at) => at === 0)
  return globSteps(glob.replace(/^(?:\.\/|\/)+/, "")).reduce((reached, step) => stepped(path, reached, step), start)[path.length] === true
}

/** A glob too long, or empty: the failure in words; else the glob. */
export const globRefusal = (glob: string): Result.Result<string, string> =>
  glob.length === 0 ? Result.fail("The glob is empty: give one such as src/**/*.ts.")
    : glob.length > GLOB_LIMIT ? Result.fail(`The glob has ${glob.length} characters; give at most ${GLOB_LIMIT}.`)
      : Result.succeed(glob)

/**
 * The tracked files a glob matches, as the model reads them: how many, then at most `LIST_LIMIT` paths in code-unit
 * order, then how many more and how to narrow the glob; or that none matches.
 */
export const listText = (glob: string, paths: ReadonlyArray<string>): string => {
  const matched = Arr.sort(paths.filter((path) => globMatches(glob, path)), Order.String)
  const quoted = JSON.stringify(glob)
  if (matched.length === 0) return `No tracked file matches ${quoted}.`
  const more = matched.length - LIST_LIMIT
  return [
    `${matched.length} ${matched.length === 1 ? "file matches" : "files match"} ${quoted}${more > 0 ? `; the first ${LIST_LIMIT}` : ""}:`,
    ...matched.slice(0, LIST_LIMIT).map(shownPath),
    ...(more > 0 ? [`${more} more: narrow the glob.`] : []),
  ].join("\n")
}

/**
 * A page of one changed file's diff, rendered as the packed diff is (`renderDiff`), `DIFF_PAGE` lines a page, under a
 * line naming the file and the page and over a line saying how to read on; or why there is none: the pull request
 * does not change that path (by its new or old name), or the page is past the last.
 */
export const diffPage = (files: ReadonlyArray<FileDiff>, path: string, page: number): Result.Result<string, string> => {
  const shown = shownPath(path)
  const file = files.find((one) => one.path === path) ?? files.find((one) => Option.contains(one.oldPath, path))
  if (file === undefined) return Result.fail(`${shown} is not a file this pull request changes: give a path from a File: line of the diff.`)
  const lines = renderDiff([file]).split("\n")
  const pages = Math.max(1, Math.ceil(lines.length / DIFF_PAGE))
  if (page > pages) return Result.fail(`The diff of ${shown} has ${pages} ${pages === 1 ? "page" : "pages"}: give page between 1 and ${pages}.`)
  const next = page < pages ? `Call ${READ_DIFF} with page ${page + 1} for the rest.` : "This is the end of this file's diff."
  return Result.succeed([`The diff of ${shown}, page ${page} of ${pages}:`, ...lines.slice((page - 1) * DIFF_PAGE, page * DIFF_PAGE), next].join("\n"))
}

/** A regular expression git cannot read, in fixed words (git's own may name a host path). */
export const REGEX_REFUSED = "git cannot read the pattern as an extended regular expression: check its brackets and escapes, or leave regex out to search for the text as it is."

/** A search stopped at its time limit. */
export const SEARCH_TOO_LONG = `The search took longer than ${GREP_TIMEOUT_MS / 1000} seconds: narrow it with path or a longer pattern.`

/** A search whose output was longer than the host keeps. */
export const SEARCH_TOO_BIG = "The search found more than can be read: narrow it with path or a longer pattern."

/** A git command of a tool's that failed otherwise: fixed words, since git's own may name a host path. */
export const GIT_FAILED = "git could not read the commit under review for this call: try it again, or go on without it."

/** What `reportFinding` answers: the finding's number in its pass. */
export const recordedText = (number: number): string => `recorded finding ${number}`
