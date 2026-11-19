import { Schema } from "effect"

/** The cache root a checkout keeps its clones under is inside a git repository, where a clone must never go. */
export class CacheRootRefused extends Schema.TaggedError<CacheRootRefused>()("CacheRootRefused", {
  root: Schema.String,
  message: Schema.String,
}) {}

/** A commit the review needs is not in the clone after fetching it: the forge no longer has it, or never had it. */
export class CommitMissing extends Schema.TaggedError<CommitMissing>()("CommitMissing", {
  sha: Schema.String,
  message: Schema.String,
}) {}

/** A transport git may use to reach a repository: `https` for a forge, `ssh`, or `file` for a folder (tests). */
export const Transport = Schema.Literals(["https", "ssh", "file"])
export type Transport = typeof Transport.Type

/** A blob's id in git: forty (SHA-1) or sixty-four (SHA-256) lower-case hexadecimal digits. */
export const BlobSha = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)).pipe(Schema.brand("BlobSha"))
export type BlobSha = typeof BlobSha.Type

/**
 * What a path is in a commit's tree, as `git ls-tree` lists it: a regular file (`File`, mode 100644 or 100755) with
 * its blob and its size in bytes, a symbolic link (`Link`, 120000), a submodule (`Submodule`, a commit), a folder
 * (`Folder`, a tree), or nothing (`Missing`). Only a `File` is ever read: a link's target is the pull request's text
 * and may point anywhere.
 */
export const TreeEntry = Schema.Union([
  Schema.TaggedStruct("File", { blob: BlobSha, bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
  Schema.TaggedStruct("Link", {}),
  Schema.TaggedStruct("Submodule", {}),
  Schema.TaggedStruct("Folder", {}),
  Schema.TaggedStruct("Missing", {}),
])
export type TreeEntry = typeof TreeEntry.Type

/**
 * What a search of a commit's tracked files asks: the pattern, read literally unless `regex`, a file or folder to
 * search in, and the most lines it reads of one file (`git grep --max-count`).
 */
export const GrepRequest = Schema.Struct({
  pattern: Schema.String,
  regex: Schema.Boolean,
  path: Schema.OptionFromNullOr(Schema.String),
  maxPerFile: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})
export type GrepRequest = typeof GrepRequest.Type

/** One line a search found: the file's path, the line's number and its text. */
export const GrepHit = Schema.Struct({
  path: Schema.String,
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  text: Schema.String,
})
export type GrepHit = typeof GrepHit.Type

/** Git refused a search's pattern (a regular expression it cannot read): git's own words, stripped and cut. */
export class PatternRefused extends Schema.TaggedError<PatternRefused>()("PatternRefused", {
  message: Schema.String,
}) {}

/** How long a search of a commit's files may run before it is stopped, in milliseconds. */
export const GREP_TIMEOUT_MS = 30_000
