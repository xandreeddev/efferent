import { Schema } from "effect"

/**
 * Why a file is left out of the diff the model reads: a lockfile, a file `.gitattributes` marks
 * `linguist-generated` or one it or its folder marks vendored, a binary file, a file the change only deletes lines
 * from, or one the token budget had no room for.
 */
export const DropReason = Schema.Literals(["lockfile", "generated", "vendored", "binary", "deletion-only", "over-budget"])
export type DropReason = typeof DropReason.Type

/** The words for each reason, as a summary and the model read them. */
export const DROPPED_BECAUSE: Readonly<Record<DropReason, string>> = {
  lockfile: "a lockfile",
  generated: "marked generated",
  vendored: "vendored code",
  binary: "a binary file",
  "deletion-only": "only deletes lines",
  "over-budget": "no room in the token budget",
}

/** A file kept in the diff, or dropped with its reason. */
export const FileVerdict = Schema.Union([
  Schema.TaggedStruct("Kept", { path: Schema.String }),
  Schema.TaggedStruct("Dropped", { path: Schema.String, reason: DropReason }),
])
export type FileVerdict = typeof FileVerdict.Type

/** What a verdict reads of a file besides its path: the lines it adds and removes, and whether git saw it as binary. */
export const FileStats = Schema.Struct({
  additions: Schema.Int,
  deletions: Schema.Int,
  binary: Schema.Boolean,
})
export type FileStats = typeof FileStats.Type

/**
 * A line of `.gitattributes` the verdict reads: its pattern and whether it sets `linguist-generated` or
 * `linguist-vendored` (`true` set, `false` unset with `-` or `=false`); an attribute it does not name is none.
 */
export const AttributeRule = Schema.Struct({
  pattern: Schema.String,
  generated: Schema.OptionFromNullOr(Schema.Boolean),
  vendored: Schema.OptionFromNullOr(Schema.Boolean),
})
export type AttributeRule = typeof AttributeRule.Type
