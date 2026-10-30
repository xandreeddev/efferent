import { Option, Result, TextDiff } from "effect"
import type { Failure } from "@xandreed/core"
import type { EditPlan, EditSpan, LineEnding } from "./text-edit.entity.js"
import type { TextEdit } from "./workspace-tools.entity.js"

const failure = (error: string, message: string): Failure => ({ error, message })

/** How `text` ends its lines (see `LineEnding`). */
export const lineEndingOf = (text: string): LineEnding =>
  !text.includes("\r") ? "lf" : text.includes("\r\n") && !/(^|[^\r])\n/.test(text) ? "crlf" : "mixed"

/**
 * A line as the fallback compares it: Unicode compatibility forms folded
 * (NFKC, which also makes a no-break space a space), curly quotes and
 * primes made straight, dashes and the minus sign made `-`, runs of
 * whitespace made one space, and the ends trimmed.
 */
export const normalizeLine = (line: string): string => line.normalize("NFKC")
  .replace(/[‘’‚‛′‵]/g, "'")
  .replace(/[“”„‟″‶]/g, "\"")
  .replace(/[‐-―−]/g, "-")
  .replace(/\s+/g, " ")
  .trim()

const label = (index: number, count: number): string => count === 1 ? "oldText" : `edit ${index + 1}'s oldText`

/** Where an edit's text is, exactly; none when it is not there, a failure when it is there more than once. */
const exactSpan = (base: string, edit: TextEdit, index: number, count: number): Result.Result<Option.Option<EditSpan>, Failure> => {
  const first = base.indexOf(edit.oldText)
  if (first < 0) return Result.succeed(Option.none())
  if (base.indexOf(edit.oldText, first + 1) >= 0) {
    return Result.fail(failure("AmbiguousMatch", `${label(index, count)} appears ${Math.max(2, base.split(edit.oldText).length - 1)} times; add surrounding lines so it appears exactly once`))
  }
  return Result.succeed(Option.some({ index, start: first, end: first + edit.oldText.length, newText: edit.newText, normalized: false }))
}

/**
 * Where an edit's text is once lines are normalised (`normalizeLine`): the
 * whole lines of `base` whose normalised forms equal the normalised lines of
 * `oldText`. The span covers the line break after the last of them when
 * `oldText` ends with one, as an exact match of it would, and otherwise
 * stops before that break (and before a `\r` ending the line), so
 * `newText` takes the matched lines' place just as it would on an exact
 * match. None when no run of lines matches, a failure when several do.
 */
const normalizedSpan = (base: string, edit: TextEdit, index: number, count: number): Result.Result<Option.Option<EditSpan>, Failure> => {
  const withBreak = edit.oldText.endsWith("\n")
  const wantedLines = edit.oldText.split("\n")
  const wanted = (withBreak ? wantedLines.slice(0, -1) : wantedLines).map(normalizeLine)
  if (wanted.every((line) => line.length === 0)) return Result.succeed(Option.none())
  const lines = base.split("\n")
  const normal = lines.map(normalizeLine)
  const starts = Array.from({ length: Math.max(0, lines.length - wanted.length + 1) }, (_, at) => at)
    .filter((at) => wanted.every((line, offset) => normal[at + offset] === line))
  const [start, ...others] = starts
  if (start === undefined) return Result.succeed(Option.none())
  if (others.length > 0) return Result.fail(failure("AmbiguousMatch", `${label(index, count)} matches ${starts.length} places once whitespace and quotes are normalised; add surrounding lines so it matches exactly once`))
  const lineStart = (line: number): number => lines.slice(0, line).reduce((total, text) => total + text.length + 1, 0)
  const after = start + wanted.length
  const lastLine = lines[after - 1] ?? ""
  const end = withBreak ? Math.min(base.length, lineStart(after)) : lineStart(after) - 1 - (lastLine.endsWith("\r") ? 1 : 0)
  return Result.succeed(Option.some({ index, start: lineStart(start), end, newText: edit.newText, normalized: true }))
}

const spanOf = (base: string, edit: TextEdit, index: number, count: number, fuzzy: boolean): Result.Result<EditSpan, Failure> => {
  if (edit.oldText.length === 0) return Result.fail(failure("EmptyOldText", `${label(index, count)} is empty; to create a file or replace all of it, use write`))
  return Result.flatMap(exactSpan(base, edit, index, count), Option.match({
    onSome: Result.succeed,
    onNone: () => Result.flatMap(fuzzy ? normalizedSpan(base, edit, index, count) : Result.succeed(Option.none<EditSpan>()), Option.match({
      onSome: Result.succeed,
      onNone: () => Result.fail(failure("NoMatch", `${label(index, count)} was not found in the file; read it again and copy the text exactly, whitespace included`)),
    })),
  }))
}

/**
 * Apply edits to a file's text. Every edit is matched against the original,
 * never against another edit's result: its `oldText` must appear exactly
 * once (an empty one is refused), or, with `fuzzy`, once over whole lines
 * after `normalizeLine`. The spans must not overlap. A text whose every
 * line break is `\r\n` is matched with `\n` breaks (in it and in the edits)
 * and written back with `\r\n`; a text without `\r` gets the edits' `\r\n`
 * as `\n`. Edits that leave the text as it was fail with `NoChange`.
 */
export const applyTextEdits = (original: string, edits: ReadonlyArray<TextEdit>, options: { readonly fuzzy: boolean }): Result.Result<EditPlan, Failure> => {
  const ending = lineEndingOf(original)
  const plain = (text: string) => ending === "mixed" ? text : text.replaceAll("\r\n", "\n")
  const base = plain(original)
  const found = Result.all(edits.map((edit, index) => spanOf(base, { oldText: plain(edit.oldText), newText: plain(edit.newText) }, index, edits.length, options.fuzzy)))
  return Result.flatMap(found, (spans) => {
    const ordered = [...spans].sort((left, right) => left.start - right.start)
    const clash = ordered.findIndex((span, at) => at > 0 && span.start < (ordered[at - 1]?.end ?? 0))
    if (clash > 0) {
      const [first, second] = [ordered[clash - 1]?.index ?? 0, ordered[clash]?.index ?? 0].sort((left, right) => left - right)
      return Result.fail(failure("OverlappingEdits", `edits ${(first ?? 0) + 1} and ${(second ?? 0) + 1} change overlapping text; merge them into one edit`))
    }
    const built = ordered.reduce((state, span) => ({ text: state.text + base.slice(state.at, span.start) + span.newText, at: span.end }), { text: "", at: 0 })
    const after = built.text + base.slice(built.at)
    if (after === base) return Result.fail(failure("NoChange", "the edits leave the file as it is"))
    const firstStart = ordered[0]?.start ?? 0
    return Result.succeed({
      text: ending === "crlf" ? after.replaceAll("\n", "\r\n") : after,
      before: base,
      after,
      replaced: ordered.length,
      normalized: ordered.some((span) => span.normalized),
      firstChangedLine: base.slice(0, firstStart).split("\n").length,
    })
  })
}

/**
 * The change as a unified diff (`--- path` / `+++ path`), from effect's
 * `TextDiff` with at most 10 000 edits searched per changed region (beyond
 * that the diff stays valid, just not minimal), cut to `maxBytes` characters
 * with a note when longer.
 */
export const unifiedDiff = (path: string, before: string, after: string, maxChars: number): string => {
  const diff = TextDiff.unified(TextDiff.lines(before, after, { maxEdits: 10_000 }), { fromFile: path, toFile: path })
  return diff.length <= maxChars ? diff : `${diff.slice(0, maxChars)}\n[diff cut at ${maxChars} characters]\n`
}
