import { Schema } from "effect"

export const LedgerEntry = Schema.Struct({
  at: Schema.String,
  /** `posting` is the INTENT row written before a post leaves (fail-closed:
   *  no row, no post) — a crash mid-post still leaves a trace and still
   *  counts as engaged; `post_failed` records a refused post and frees the
   *  target for a retry. */
  event: Schema.Literals(
    ["drafted",
    "gate_rejected",
    "queued",
    "posting",
    "posted",
    "post_failed",
    "discarded",
    "skipped"],
  ),
  kind: Schema.Literals(["reply", "post"]),
  targetTweetId: Schema.optional(Schema.String),
  targetAuthor: Schema.optional(Schema.String),
  referenceBlogSlug: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  findings: Schema.optional(Schema.Array(Schema.String)),
  filename: Schema.optional(Schema.String),
})
export type LedgerEntry = typeof LedgerEntry.Type

export const LedgerError = Schema.TaggedStruct("LedgerError", { message: Schema.String })
export type LedgerError = typeof LedgerError.Type
