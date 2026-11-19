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

/** The path of a `diff --git a/X b/X` header, when both sides name the same path; a rename's comes from its own lines. */
const headerPath = (line: string): string => {
  const rest = line.slice("diff --git ".length)
  const half = (rest.length - 5) / 2
  if (Number.isInteger(half) && half > 0 && rest.startsWith("a/") && rest.slice(2 + half, 5 + half) === " b/" && rest.slice(2, 2 + half) === rest.slice(5 + half)) return rest.slice(2, 2 + half)
  const quoted = /^"?a\/(.*?)"? "?b\/(.*?)"?$/.exec(rest)
  return quoted?.[2] ?? rest
}

interface Draft {
  path: string
  oldPath: Option.Option<string>
  change: FileChange
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
    const draft: Draft = { path: headerPath(header), oldPath: Option.none(), change: "modified", binary: false, hunks: [] }
    let minus: Option.Option<string> = Option.none()
    let plus: Option.Option<string> = Option.none()
    at += 1
    while (at < lines.length && !(lines[at] ?? "").startsWith("diff --git ") && !(lines[at] ?? "").startsWith("@@")) {
      const line = lines[at] ?? ""
      if (line.startsWith("new file mode")) draft.change = "added"
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

/** A file's header line: its path, how it changed (a rename with its old path), and the lines added and removed. */
const fileHeader = (file: FileDiff): string => {
  const how = Option.match(file.oldPath, {
    onNone: () => CHANGE_WORDS[file.change],
    onSome: (old) => `${CHANGE_WORDS[file.change]} from ${old}`,
  })
  return `File: ${file.path} (${how}, +${file.additions} -${file.deletions}${file.binary ? ", binary, not shown" : ""})`
}

/**
 * The diff as the model reads it, deterministic for the same files: per file a header line (`fileHeader`), then each
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
