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
