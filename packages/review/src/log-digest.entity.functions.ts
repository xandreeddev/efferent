import { Option } from "effect"
import { clipTo } from "@xandreed/sdk"
import { DIGEST_LIMITS, FAILURE_SHOWN, FAILURES_KEPT, SUMMARY_KEPT, SUMMARY_SHOWN } from "./log-digest.entity.js"
import type { DigestLimits, Digested, LogFailure } from "./log-digest.entity.js"

const CI_PREFIX = /^[^\t]*\t[^\t]*\t/
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/
/** OSC (`ESC ]` … BEL or `ESC \\`), CSI (`ESC [` … final byte) and every other escape (`ESC`, intermediates, a final). */
const ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]?/g
/** Every control character but a tab: C0, DEL and C1. */
const CONTROLS = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g
const MARKER = /^##\[(group|endgroup|warning|notice|debug|command)\]/
const ERROR_MARKER = /^##\[error\]/
const EXIT_LINE = /^Process completed with exit code \d+\.?$/
const SUMMARY = [
  /^\d+ (pass|fail|skip|todo|error)s?$/,
  /^\d+ tests? failed:?$/,
  /^Ran \d+ tests?\b/,
  /^Found \d+ errors?\b/,
  /^✖ \d+ problems?\b/,
  /^Tests?:?\s+.*\d+ (failed|passed)/,
  EXIT_LINE,
]
const ERROR_LINE = [
  /^error(\[\w+\])?:/i,
  /\berror TS\d+:/,
]
/** A failed test's title: the runner printed its error before it, so no location line after it is its own. */
const TITLE_LINE = [/^\(fail\) /, /^FAIL\s/]
/** A failure's line says something: it holds a letter or a digit (an annotation of a lone `[` does not). */
const SAYS = /[A-Za-z0-9]/
const DEPENDENCY_FRAME = /\/node_modules\//
const ESLINT_ERROR = /^(\d+):(\d+)\s+error\s+(.*)$/
const FILE_HEADER = /^(?:\/|\.{1,2}\/)?[\w@.+-]+(?:\/[\w@.+-]+)*\.\w+$/
const LOCATION = [/^at\s/, /^-->\s/, /^❯\s/, /\.[cm]?[jt]sx?:\d+(?::\d+)?\)?$/]
const DURATION = /\s\[[\d.]+m?s\]$/
const PATH_TOKEN = /[\w@.+-]+(?:\/[\w@.+-]+)+\.\w+/g

/** A text without terminal escape sequences (OSC, CSI and the rest) and without control characters but tabs. */
export const plainText = (text: string): string => text.replace(ESCAPES, "").replace(CONTROLS, "")

/** A log line without what CI puts before it (`job<TAB>step<TAB>`, a timestamp, read first: the prefix is tabs) and plain. */
const cleaned = (line: string): string => plainText(line.replace(CI_PREFIX, "").replace(TIMESTAMP, ""))

/** Whether a failure's lines name a changed path: whole, or as a path that ends one (a package's own `src/x.ts`). */
const namesChanged = (lines: ReadonlyArray<string>, changedPaths: ReadonlyArray<string>): boolean =>
  lines.some((line) =>
    changedPaths.some((path) => line.includes(path)) ||
    [...line.matchAll(PATH_TOKEN)].some(([token = ""]) => changedPaths.some((path) => path.endsWith(`/${token}`))))

interface Draft {
  readonly text: string
  readonly detail: Array<string>
  count: number
  readonly first: number
}

/**
 * The digest of a log: its error lines (`(fail)` and `error:` lines, `error TS…`, `FAIL`, an eslint `line:col error`
 * under the file named above it, and CI's `##[error]` annotations), each with up to `detailLines` location lines
 * (`at …`, `--> …`, a line ending in a source's `file:line`, never a frame in `node_modules`) met after it and before
 * the next failure (a `(fail)` or `FAIL` title takes none: its error came before it); a line with no letter or digit is
 * no failure; identical failures kept once with a count; those that name a changed path first, then in the order
 * first seen. The summary is the runner's count and exit lines, in order, each once, joined by `; `. The lines shown
 * are each failure (` (seen N times)` after one seen more than once) and its location lines indented, then the
 * summary, at most `maxLines`: failures are cut first, and `linesCut` counts what the cap left out. CI's prefixes
 * (`job<TAB>step<TAB>timestamp`), escape sequences and control characters are read past. Each failure's line and
 * location line is cut at `FAILURE_SHOWN` with `clipTo` (its marker a line of its own, counted against `maxLines`),
 * at most `FAILURES_KEPT` failures are kept (`failuresCut` counts the rest) and the last `SUMMARY_KEPT` summary lines,
 * cut at `SUMMARY_SHOWN`. Everything the digest holds is the pull request's text: data, never instructions.
 */
export const digestLog = (text: string, changedPaths: ReadonlyArray<string>, limits: DigestLimits = DIGEST_LIMITS): Digested => {
  const raw = text.split("\n")
  if (raw.at(-1) === "") raw.pop()
  const lines = raw.map(cleaned)
  const drafts = new Map<string, Draft>()
  const summaries: Array<string> = []
  let file: Option.Option<string> = Option.none()
  let open: Option.Option<Draft> = Option.none()
  lines.forEach((line, at) => {
    const trimmed = line.trim()
    if (MARKER.test(trimmed)) return
    const annotated = ERROR_MARKER.test(trimmed)
    const content = trimmed.replace(ERROR_MARKER, "").trim()
    if (SUMMARY.some((pattern) => pattern.test(content))) {
      const summary = content.replace(/:$/, "")
      if (!summaries.includes(summary)) summaries.push(summary)
      open = Option.none()
      return
    }
    if (FILE_HEADER.test(line)) {
      file = Option.some(line)
      open = Option.none()
      return
    }
    const eslint = ESLINT_ERROR.exec(content)
    const title = TITLE_LINE.some((pattern) => pattern.test(content))
    const failure = eslint !== null
      ? Option.some(`${Option.getOrElse(file, () => "")}:${eslint[1]}:${eslint[2]} error ${eslint[3]?.replace(/\s{2,}/g, " ") ?? ""}`.replace(/^:/, ""))
      : annotated || title || ERROR_LINE.some((pattern) => pattern.test(content))
        ? Option.some(content.replace(DURATION, ""))
        : Option.none<string>()
    if (Option.isSome(failure)) {
      open = Option.none()
      if (!SAYS.test(failure.value)) return
      const seen = drafts.get(failure.value)
      if (seen === undefined) {
        const draft: Draft = { text: failure.value, detail: [], count: 1, first: at }
        drafts.set(failure.value, draft)
        if (!title) open = Option.some(draft)
      } else seen.count += 1
      return
    }
    // A location line belongs to the last failure met since the last summary or file: a runner may print the
    // expectation's diff between the two.
    if (Option.isSome(open) && LOCATION.some((pattern) => pattern.test(content)) && !DEPENDENCY_FRAME.test(content) && open.value.detail.length < limits.detailLines) open.value.detail.push(content)
  })
  const sorted = [...drafts.values()]
    .map((draft) => ({ draft, onChangedPath: namesChanged([draft.text, ...draft.detail], changedPaths) }))
    .sort((a, b) => Number(b.onChangedPath) - Number(a.onChangedPath) || a.draft.first - b.draft.first)
  const failures: ReadonlyArray<LogFailure> = sorted.slice(0, FAILURES_KEPT)
    .map(({ draft, onChangedPath }) => ({ text: clipTo(draft.text, FAILURE_SHOWN), detail: draft.detail.map((line) => clipTo(line, FAILURE_SHOWN)), count: draft.count, onChangedPath }))
  const kept = summaries.slice(-SUMMARY_KEPT)
  const summary = kept.length > 0 ? Option.some(clipTo(kept.join("; "), SUMMARY_SHOWN)) : Option.none<string>()
  const failureLines = failures.flatMap((failure) => [
    failure.count > 1 ? `${failure.text} (seen ${failure.count} times)` : failure.text,
    ...failure.detail.map((line) => `  ${line}`),
  ]).flatMap((line) => line.split("\n"))
  const summaryLines = Option.match(summary, { onNone: () => [], onSome: (text) => text.split("\n") })
  const room = Math.max(0, limits.maxLines - summaryLines.length)
  const shown = failureLines.slice(0, room)
  return {
    summary,
    failures,
    failuresCut: sorted.length - failures.length,
    onChangedPath: sorted.some((failure) => failure.onChangedPath),
    lines: [...shown, ...summaryLines].slice(0, limits.maxLines),
    linesCut: failureLines.length - shown.length,
    logLines: raw.length,
  }
}
