import { Match, Option, Result } from "effect"
import { DiffUnreadable } from "./diff.entity.js"
import type { DiffLine, FileChange, FileDiff, Hunk } from "./diff.entity.js"

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/

/** A path as git prints it in a header: C-quoted when it holds a quote, a backslash or a control character. */
const unquoted = (text: string): string => {
  if (!(text.startsWith("\"") && text.endsWith("\"") && text.length >= 2)) return text
  const escapes: Readonly<Record<string, string>> = { n: "\n", t: "\t", "\"": "\"", "\\": "\\", a: "\x07", b: "\b", f: "\f", r: "\r", v: "\v" }
  const bytes: Array<number> = []
  const body = text.slice(1, -1)
  for (let at = 0; at < body.length; at++) {
    const char = body[at] ?? ""
    if (char !== "\\") {
      bytes.push(...new TextEncoder().encode(char))
      continue
    }
    const octal = /^[0-7]{3}/.exec(body.slice(at + 1))
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8))
      at += 3
      continue
    }
    const next = body[at + 1] ?? ""
    bytes.push(...new TextEncoder().encode(escapes[next] ?? next))
    at += 1
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/** A path of a `---` or `+++` line, without git's `a/` or `b/`; none for `/dev/null`. */
const sidePath = (text: string): Option.Option<string> => {
  const path = unquoted(text.replace(/\t$/, ""))
  if (path === "/dev/null") return Option.none()
  return Option.some(path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path)
}

/** The length of a C-quoted token at the start of `text` (its quotes included), or 0 when it starts with none. */
const quotedLength = (text: string): number => {
  if (!text.startsWith("\"")) return 0
  for (let at = 1; at < text.length; at++) {
    if (text[at] === "\\") at += 1
    else if (text[at] === "\"") return at + 1
  }
  return 0
}

/** A side's path without git's `a/` or `b/`. */
const sideless = (path: string): string => (path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path)

/**
 * The new side's path of a `diff --git <a> <b>` header, either side C-quoted or not, for a file with no `---` and
 * `+++` lines to read it from (a binary file, a mode change, a pure rename). Two unquoted sides are told apart as two
 * equal halves; a rename's names come from its own lines.
 */
const headerPath = (line: string): string => {
  const rest = line.slice("diff --git ".length)
  const first = quotedLength(rest)
  if (first > 0) {
    const second = rest.slice(first + 1)
    return sideless(quotedLength(second) > 0 ? unquoted(second) : second)
  }
  const lastQuote = rest.endsWith("\"") ? rest.lastIndexOf(" \"b/") : -1
  if (lastQuote > 0) return sideless(unquoted(rest.slice(lastQuote + 1)))
  const half = (rest.length - 5) / 2
  if (Number.isInteger(half) && half > 0 && rest.startsWith("a/") && rest.slice(2 + half, 5 + half) === " b/" && rest.slice(2, 2 + half) === rest.slice(5 + half)) return rest.slice(2, 2 + half)
  const split = rest.indexOf(" b/")
  return split > 0 ? rest.slice(split + 3) : rest
}

interface Draft {
  path: string
  oldPath: Option.Option<string>
  change: FileChange
  oldMode: Option.Option<string>
  newMode: Option.Option<string>
  binary: boolean
  hunks: Array<Hunk>
}

/**
 * Read a unified diff as git prints it (`git diff`, with or without renames found): each file with how it changed,
 * whether it is binary, and its hunks, each line with its number in the new file. A hunk is read by its counts, so a
 * removed line that starts with `--` or a line that is blank is read as what it is. Text before the first file is
 * passed over; a hunk whose counts its lines do not fill is `DiffUnreadable`.
 */
export const parseUnifiedDiff = (text: string): Result.Result<ReadonlyArray<FileDiff>, DiffUnreadable> => {
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  const files: Array<FileDiff> = []
  let at = 0
  const finish = (draft: Draft) => {
    const all = draft.hunks.flatMap((hunk) => hunk.lines)
    files.push({
      path: draft.path,
      oldPath: draft.oldPath,
      change: draft.change,
      modeChange: Option.isSome(draft.oldMode) && Option.isSome(draft.newMode) ? Option.some({ from: draft.oldMode.value, to: draft.newMode.value }) : Option.none(),
      binary: draft.binary,
      additions: all.filter((line) => line._tag === "Added").length,
      deletions: all.filter((line) => line._tag === "Removed").length,
      hunks: draft.hunks,
    })
  }
  while (at < lines.length) {
    const header = lines[at] ?? ""
    if (!header.startsWith("diff --git ")) {
      at += 1
      continue
    }
    const draft: Draft = { path: headerPath(header), oldPath: Option.none(), change: "modified", oldMode: Option.none(), newMode: Option.none(), binary: false, hunks: [] }
    let minus: Option.Option<string> = Option.none()
    let plus: Option.Option<string> = Option.none()
    at += 1
    while (at < lines.length && !(lines[at] ?? "").startsWith("diff --git ") && !(lines[at] ?? "").startsWith("@@")) {
      const line = lines[at] ?? ""
      if (line.startsWith("old mode ")) draft.oldMode = Option.some(line.slice("old mode ".length))
      else if (line.startsWith("new mode ")) draft.newMode = Option.some(line.slice("new mode ".length))
      else if (line.startsWith("new file mode")) draft.change = "added"
      else if (line.startsWith("deleted file mode")) draft.change = "deleted"
      else if (line.startsWith("rename from ")) {
        draft.oldPath = Option.some(unquoted(line.slice("rename from ".length)))
        draft.change = "renamed"
      } else if (line.startsWith("rename to ")) draft.path = unquoted(line.slice("rename to ".length))
      else if (line.startsWith("Binary files ") || line === "GIT binary patch") draft.binary = true
      else if (line.startsWith("--- ")) minus = sidePath(line.slice(4))
      else if (line.startsWith("+++ ")) plus = sidePath(line.slice(4))
      at += 1
    }
    draft.path = Option.getOrElse(Option.orElse(plus, () => minus), () => draft.path)
    while (at < lines.length && (lines[at] ?? "").startsWith("@@")) {
      const hunkAt = at
      const match = HUNK_HEADER.exec(lines[at] ?? "")
      if (match === null) return Result.fail(new DiffUnreadable({ line: hunkAt + 1, message: `the hunk header ${JSON.stringify(lines[at])} does not read as one` }))
      const oldStart = Number(match[1])
      const oldCount = match[2] === undefined ? 1 : Number(match[2])
      const newStart = Number(match[3])
      const newCount = match[4] === undefined ? 1 : Number(match[4])
      let oldLeft = oldCount
      let newLeft = newCount
      let newLine = newStart
      const body: Array<DiffLine> = []
      at += 1
      while (oldLeft > 0 || newLeft > 0) {
        if (at >= lines.length) return Result.fail(new DiffUnreadable({ line: hunkAt + 1, message: `the hunk ends before its ${oldCount} old and ${newCount} new lines` }))
        const line = lines[at] ?? ""
        const mark = line.slice(0, 1)
        const rest = line.slice(1)
        if (mark === "\\") body.push({ _tag: "NoNewline" })
        else if (mark === "+" && newLeft > 0) {
          body.push({ _tag: "Added", line: newLine, text: rest })
          newLine += 1
          newLeft -= 1
        } else if (mark === "-" && oldLeft > 0) {
          body.push({ _tag: "Removed", text: rest })
          oldLeft -= 1
        } else if ((mark === " " || line === "") && oldLeft > 0 && newLeft > 0) {
          body.push({ _tag: "Context", line: newLine, text: rest })
          newLine += 1
          oldLeft -= 1
          newLeft -= 1
        } else return Result.fail(new DiffUnreadable({ line: at + 1, message: `the line ${JSON.stringify(line.slice(0, 80))} does not fit its hunk's counts` }))
        at += 1
      }
      if ((lines[at] ?? "").startsWith("\\")) {
        body.push({ _tag: "NoNewline" })
        at += 1
      }
      draft.hunks.push({ oldStart, oldCount, newStart, newCount, section: match[5]?.trim() ?? "", lines: body })
    }
    finish(draft)
  }
  return Result.succeed(files)
}

const CHANGE_WORDS: Readonly<Record<FileChange, string>> = {
  added: "added",
  deleted: "deleted",
  modified: "modified",
  renamed: "renamed",
}

const UNSAFE = /[\\"\u0000-\u001f\u007f-\u009f\u2028\u2029]/

/**
 * A path as the model and a person read it: as it is when it holds only printable characters and no `"` or `\\`;
 * otherwise in double quotes with `\\` and `"` escaped and each control character (C0, DEL, C1, U+2028, U+2029) as
 * `\\uXXXX`, a JSON string, so a name cannot forge a line and a shown path maps back to exactly one file.
 */
export const shownPath = (path: string): string =>
  UNSAFE.test(path)
    ? `"${path.replace(new RegExp(UNSAFE.source, "g"), (char) => (char === "\\" ? "\\\\" : char === "\"" ? "\\\"" : `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`))}"`
    : path

/** A file's header line: its path, how it changed (a rename with its old path, a mode change), and its counts. */
const fileHeader = (file: FileDiff): string => {
  const how = Option.match(file.oldPath, {
    onNone: () => CHANGE_WORDS[file.change],
    onSome: (old) => `${CHANGE_WORDS[file.change]} from ${shownPath(old)}`,
  })
  const mode = Option.match(file.modeChange, { onNone: () => "", onSome: ({ from, to }) => `, mode ${from} to ${to}` })
  return `File: ${shownPath(file.path)} (${how}${mode}, +${file.additions} -${file.deletions}${file.binary ? ", binary, not shown" : ""})`
}

/**
 * The diff as the model reads it, deterministic for the same files: per file a header line (`fileHeader`, its paths
 * through `shownPath`), then each
 * hunk under `@@` and the enclosing function's line git found for it (nothing more when it found none), each line
 * with its number in the new file, then `+` for an added line or a space for one left as it was; a removed line has
 * no number, only `-`. Numbers are right-aligned to the widest in the file, so a finding can cite `path:line`. Git's
 * `\ No newline at end of file` is left out. Files are separated by a blank line.
 */
export const renderDiff = (files: ReadonlyArray<FileDiff>): string =>
  files.map((file) => {
    const numbers = file.hunks.flatMap((hunk) => hunk.lines.flatMap((line) => (line._tag === "Added" || line._tag === "Context" ? [line.line] : [])))
    const width = Math.max(1, ...numbers.map((number) => String(number).length))
    const blank = " ".repeat(width)
    const hunks = file.hunks.map((hunk) => {
      const lines = hunk.lines.flatMap((line): ReadonlyArray<string> => Match.valueTags(line, {
        Added: (added) => [`${String(added.line).padStart(width)} + ${added.text}`],
        Context: (context) => [`${String(context.line).padStart(width)}   ${context.text}`],
        Removed: (removed) => [`${blank} - ${removed.text}`],
        NoNewline: () => [],
      }))
      return [hunk.section.length > 0 ? `@@ ${hunk.section}` : "@@", ...lines].join("\n")
    })
    return [fileHeader(file), ...hunks].join("\n")
  }).join("\n\n")
