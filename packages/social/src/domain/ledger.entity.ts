import { Schema } from "effect"

export const LedgerEntry = Schema.Struct({
  at: Schema.String,
  event: Schema.Literal("drafted", "gate_rejected", "queued", "posted", "discarded", "skipped"),
  kind: Schema.Literal("reply", "post"),
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
