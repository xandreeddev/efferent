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

/**
 * What kind of file a path is, for the order files are packed in: a manifest or CI file (`package.json` of any
 * workspace, a lockfile's manifests, `tsconfig*.json`, `.github/workflows/*`), other config, code, or docs.
 */
export const FileKind = Schema.Literals(["manifest", "config", "code", "docs"])
export type FileKind = typeof FileKind.Type

/**
 * How the source files are ordered among themselves when packed: in the order git lists them (`git`, the stock: on the
 * gold cases it packed the defect's file in 27 of 36 tuning cases, against 25 largest first and 21 for the earlier
 * code-largest-first packing), or largest first (`largest`).
 */
export const PackRanking = Schema.Literals(["git", "largest"])
export type PackRanking = typeof PackRanking.Type

/** The most lines a config file may change and still be packed with the manifests, before the code. */
export const SMALL_CONFIG_LINES = 200

/** How many files left out the packed diff names one by one; the rest are counted by reason. */
export const DROPPED_SHOWN = 30
