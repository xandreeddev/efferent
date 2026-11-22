import { Schema } from "effect"
import { FileDiff } from "../diff.entity.js"
import { Finding } from "../finding.entity.js"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** A known defect of the review eval: `fm-<pr>-by-<fix pr>` for one fixed on main later, `wp-<pr>-<fix commit>` for one fixed within the pull request. */
export const GoldId = Schema.NonEmptyString.pipe(Schema.brand("ReviewGoldId"))
export type GoldId = typeof GoldId.Type

/**
 * Which part of the eval a known defect is in: `tuning`, the defects the reviewer was tuned on (the bar counts these,
 * 27); `tuning-544`, those of #544, reported apart (eleven defects in one pull request outweigh the rest); `held-out`,
 * kept for the end and never run while tuning. The split was made by defect: five held-out defects are on pull
 * requests of the tuning set (#463, #465, #544, #573, #648), so a run over those reviews sees their code.
 */
export const GoldSplit = Schema.Literals(["tuning", "tuning-544", "held-out"])
export type GoldSplit = typeof GoldSplit.Type

/**
 * One known defect: the pull request and the commit reviewed (and its base), how it was mined (`fix-on-main`: a later
 * fix on main names it; `within-pr`: a later commit of the pull request fixed it), its kind and the miner's
 * confidence, what is wrong in words, and the lines of the reviewed commit it sits on, by file.
 */
export const GoldCase = Schema.Struct({
  gold: GoldId,
  pr: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  reviewSha: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  baseSha: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  split: GoldSplit,
  source: Schema.Literals(["fix-on-main", "within-pr"]),
  category: Schema.NonEmptyString,
  confidence: Schema.Literals(["high", "medium", "low"]),
  description: Schema.NonEmptyString,
  goldLines: Schema.Record(Schema.String, Schema.Array(Schema.Tuple([Schema.Int, Schema.Int]))),
})
export type GoldCase = typeof GoldCase.Type

/** The eval's known defects (`packages/review/evals/cases.json`). */
export const GoldCases = Schema.Struct({
  dataset: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  cases: Schema.Array(GoldCase),
})
export type GoldCases = typeof GoldCases.Type

/** A finding a recorded review reported, with the known defect the judge matched it to (none: it matched no known defect). */
export const RecordedFinding = Schema.Struct({ ...Finding.fields, judged: Schema.NullOr(GoldId) })
export type RecordedFinding = typeof RecordedFinding.Type

/** A recorded draw's name: one run of the reviewer over the eval's reviews, a candidate of the replay. */
export const DrawId = Schema.NonEmptyString.pipe(Schema.brand("ReviewDrawId"))
export type DrawId = typeof DrawId.Type

/**
 * One recorded draw: the reviewer as it ran (its model, effort, prompt and tool versions, read limit and the
 * characters a token it counted), what it ran over (`scope`), and every finding it reported, by review
 * (`<pr>-<first eight digits of the reviewed commit>`), each with the judge's match.
 */
export const RecordedDraw = Schema.Struct({
  id: DrawId,
  model: Schema.NonEmptyString,
  effort: Schema.NonEmptyString,
  promptVersion: Schema.NonEmptyString,
  toolsVersion: Schema.NonEmptyString,
  charsPerToken: Schema.Finite,
  readTokens: Count,
  scope: Schema.NonEmptyString,
  findings: Schema.Record(Schema.String, Schema.Array(RecordedFinding)),
})
export type RecordedDraw = typeof RecordedDraw.Type

/**
 * The recorded draws and, by review, the diffs of the files their findings and the known defects cite, as the
 * preparation read them (a removed line's text left out: nothing the replay runs reads it)
 * (`packages/review/evals/recorded.json.gz`).
 */
export const Recorded = Schema.Struct({
  draws: Schema.Array(RecordedDraw),
  files: Schema.Record(Schema.String, Schema.Array(FileDiff)),
})
export type Recorded = typeof Recorded.Type

/**
 * What a replay of one review's recorded findings gives: the known defects some finding was matched to (`found`),
 * those a bucket among the findings a review with no check shows holds a finding matched to (`shown`, the first
 * `FINDINGS_SHOWN` kept buckets in the report's order), and how many findings and kept buckets there were.
 */
export const Replayed = Schema.Struct({
  found: Schema.Array(GoldId),
  shown: Schema.Array(GoldId),
  findings: Count,
  kept: Count,
})
export type Replayed = typeof Replayed.Type
