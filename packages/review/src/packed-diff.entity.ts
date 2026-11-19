import { Schema } from "effect"
import { DropReason } from "./file-verdict.entity.js"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** A file left out of the diff the model reads, with its reason and the lines it adds and removes. */
export const DroppedFile = Schema.Struct({
  path: Schema.String,
  reason: DropReason,
  additions: Count,
  deletions: Count,
})
export type DroppedFile = typeof DroppedFile.Type

/**
 * The diff the model reads: its text (the kept files, then a line for each file left out), its estimated tokens,
 * the kept files' paths in the order the text holds them, and the files left out, in the order the text names them.
 */
export const PackedDiff = Schema.Struct({
  text: Schema.String,
  tokens: Count,
  kept: Schema.Array(Schema.String),
  dropped: Schema.Array(DroppedFile),
})
export type PackedDiff = typeof PackedDiff.Type

/** What kind of file a path is, for the order files are packed in: code first, then docs, then config. */
export const FileKind = Schema.Literals(["code", "docs", "config"])
export type FileKind = typeof FileKind.Type

/** How many files left out the packed diff names one by one; the rest are counted by reason. */
export const DROPPED_SHOWN = 30
