import { Schema } from "effect"
import { Finding, FindingKind, LineNumber, PassNumber } from "./finding.entity.js"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** How near two findings' lines may be to share a bucket: overlapping, or this many lines apart. */
export const NEAR_LINES = 3

/** How near a finding's lines must be to a changed line (an added line, or where lines were removed) to count as on it. */
export const CHANGED_SLACK = 2

/** How near the cited lines a verdict's quote must be found in the head's file. */
export const QUOTE_SLACK = 3

/** Which bucket of a review's merged findings, from 1, in path and line order. */
export const BucketNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(Schema.brand("BucketNumber"))
export type BucketNumber = typeof BucketNumber.Type

/**
 * Why a bucket was kept or not: kept for the checks (`kept`); left out by the vote, one pass alone having found it and
 * it not a security problem (`one-vote`, only when the vote is on); its findings are not on the pull request's changed
 * lines (`off-changed-lines`).
 */
export const BucketWhy = Schema.Literals(["kept", "one-vote", "off-changed-lines"])
export type BucketWhy = typeof BucketWhy.Type

/** A finding of a bucket: its pass and its number in that pass. */
export const BucketMember = Schema.Struct({ pass: PassNumber, number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) })
export type BucketMember = typeof BucketMember.Type

/**
 * The findings of several passes about one problem: one file, one kind, lines that overlap or are near
 * (`NEAR_LINES`). Its lines span its findings'; its votes are the distinct passes that found it; `best` is the
 * finding whose words stand for it (the longest evidence the file's diff holds, else the first); `kept` and `why` say
 * whether it goes to the checks. Every bucket is recorded, kept or not, for offline scoring.
 */
export const Bucket = Schema.Struct({
  number: BucketNumber,
  path: Schema.String,
  kind: FindingKind,
  line: LineNumber,
  endLine: LineNumber,
  members: Schema.Array(BucketMember),
  votes: Count,
  best: Finding,
  kept: Schema.Boolean,
  why: BucketWhy,
})
export type Bucket = typeof Bucket.Type

/** How findings are merged: whether the vote filters the buckets (two passes, or one for a security problem) or every bucket on changed lines is kept. */
export const MergeOptions = Schema.Struct({ vote: Schema.Boolean })
export type MergeOptions = typeof MergeOptions.Type
