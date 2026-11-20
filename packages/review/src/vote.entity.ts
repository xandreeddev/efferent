import { Schema } from "effect"
import { Finding, FindingKind, LineNumber, TurnNumber } from "./finding.entity.js"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** How near two findings' lines may be to share a bucket: overlapping, or this many lines apart. */
export const NEAR_LINES = 3

/** How near a finding's lines must be to a changed line (an added line, or where lines were removed) to count as on it. */
export const CHANGED_SLACK = 2

/** How near the cited lines a verdict's quote must be found in the head's file. */
export const QUOTE_SLACK = 3

/** How far from the cited lines the quote's telling line may be: one, for a numbering off by one. */
export const CITED_SLACK = 1

/** The most lines from a finding's first that count: for its bucket's place and for where its check's quote is looked for. */
export const SPAN_COUNTED = 40

/** The fewest characters other than white space a quoted line needs, with a name in it, to stand for the code it quotes. */
export const QUOTE_LINE_CHARS = 12

/** Which bucket of a review's merged findings, from 1, in path and line order. */
export const BucketNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(Schema.brand("BucketNumber"))
export type BucketNumber = typeof BucketNumber.Type

/**
 * Why a bucket was kept or not: kept for the checks (`kept`); left out by the vote, one turn alone having found it and
 * it not a security problem (`one-vote`, only when the vote is on); its findings are not on the pull request's changed
 * lines (`off-changed-lines`).
 */
export const BucketWhy = Schema.Literals(["kept", "one-vote", "off-changed-lines"])
export type BucketWhy = typeof BucketWhy.Type

/** A finding of a bucket: its turn and its number in that turn. */
export const BucketMember = Schema.Struct({ turn: TurnNumber, number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) })
export type BucketMember = typeof BucketMember.Type

/**
 * The findings of several turns about one place: one file, each finding starting within `NEAR_LINES` of the first
 * finding's lines (its anchor, counted at most `SPAN_COUNTED` lines), at most one finding a turn, whatever kind each
 * says. Its lines span its findings' (each counted at most `SPAN_COUNTED` lines); its votes are its findings, one a
 * turn; `best` is the finding whose words stand for it (the longest evidence the file's diff holds, else the first),
 * and its kind is the best's; `kept` and `why` say whether it goes to the checks. Every bucket is recorded, kept or
 * not, for offline scoring.
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

/**
 * The most findings of one bucket checked, each by a check of its own: two turns may name two mechanisms on the same
 * lines (#644's full run: a bucket held the gold leak and a different reading, and only one was checked).
 */
export const CLAIMS_CHECKED = 3

/** A check to run: the kept bucket and the one finding of it the check is shown. */
export const CheckTarget = Schema.Struct({ bucket: Bucket, finding: Finding })
export type CheckTarget = typeof CheckTarget.Type

/** How findings are merged: whether the vote filters the buckets (two turns, or one for a security problem) or every bucket on changed lines is kept. */
export const MergeOptions = Schema.Struct({ vote: Schema.Boolean })
export type MergeOptions = typeof MergeOptions.Type
