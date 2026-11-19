import { Schema } from "effect"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * One line of a hunk: a line the change adds (`Added`) or leaves (`Context`), each with its number in the new file,
 * or one it removes (`Removed`), which the new file has not. `NoNewline` is git's `\ No newline at end of file`.
 */
export const DiffLine = Schema.Union([
  Schema.TaggedStruct("Added", { line: Count, text: Schema.String }),
  Schema.TaggedStruct("Context", { line: Count, text: Schema.String }),
  Schema.TaggedStruct("Removed", { text: Schema.String }),
  Schema.TaggedStruct("NoNewline", {}),
])
export type DiffLine = typeof DiffLine.Type

/**
 * A hunk of a unified diff: where it starts and how many lines it spans on each side, the text git puts after the
 * second `@@` (the enclosing function's line, when git finds one; empty otherwise) and its lines.
 */
export const Hunk = Schema.Struct({
  oldStart: Count,
  oldCount: Count,
  newStart: Count,
  newCount: Count,
  section: Schema.String,
  lines: Schema.Array(DiffLine),
})
export type Hunk = typeof Hunk.Type

/** How a file changed. */
export const FileChange = Schema.Literals(["added", "deleted", "modified", "renamed"])
export type FileChange = typeof FileChange.Type

/**
 * One file of a diff: its path in the new tree (the old one for a deleted file), the path it had before a rename,
 * how it changed, its mode change when it has one, whether git saw it as binary (then it has no hunks), the lines
 * added and removed, and its hunks. A path is the pull request's text: it may hold any character but `/` and NUL.
 */
export const FileDiff = Schema.Struct({
  path: Schema.String,
  oldPath: Schema.OptionFromNullOr(Schema.String),
  change: FileChange,
  modeChange: Schema.OptionFromNullOr(Schema.Struct({ from: Schema.String, to: Schema.String })),
  binary: Schema.Boolean,
  additions: Count,
  deletions: Count,
  hunks: Schema.Array(Hunk),
})
export type FileDiff = typeof FileDiff.Type

/** A diff git printed that does not read as one: a hunk header or a count that does not add up. */
export class DiffUnreadable extends Schema.TaggedError<DiffUnreadable>()("DiffUnreadable", {
  line: Count,
  message: Schema.String,
}) {}
