import { Schema } from "effect"
import { Finding } from "./finding.entity.js"
import { ReviewedAt } from "./prepare-review.entity.js"
import { PullNumber, RepoName } from "./pull-request.entity.js"
import { PassResult } from "./review-pass.entity.js"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** The most findings a report shows; the rest are counted. */
export const FINDINGS_SHOWN = 6

/** The longest a finding's quoted evidence is shown in the report, in characters. */
export const EVIDENCE_SHOWN = 400

/** A finding as the report keeps it: whether it only restates a failure the CI's digest already names (same path and line). */
export const ReportedFinding = Schema.Struct({
  ...Finding.fields,
  restatesCi: Schema.Boolean,
})
export type ReportedFinding = typeof ReportedFinding.Type

/** What a review's model calls used together: tokens read (the cached share among them) and written, and what they cost. */
export const ReviewUsage = Schema.Struct({
  input: Count,
  cached: Count,
  output: Count,
  cost: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type ReviewUsage = typeof ReviewUsage.Type

/**
 * A review, as the command line prints it and keeps it beside the prepared review for offline scoring: the pull
 * request and the commit reviewed, the prompt's and the tool set's versions, the model, each pass (how it ended, its
 * calls with what each used, the files it opened), every finding (sorted by severity, then path, then line), the files
 * in the packed diff against those changed, what the calls used together, and the wall time.
 */
export const ReviewReport = Schema.Struct({
  repo: RepoName,
  number: PullNumber,
  at: ReviewedAt,
  promptVersion: Schema.String,
  toolsVersion: Schema.String,
  model: Schema.String,
  passes: Schema.Array(PassResult),
  findings: Schema.Array(ReportedFinding),
  packedFiles: Count,
  changedFiles: Count,
  usage: ReviewUsage,
  wallMs: Count,
})
export type ReviewReport = typeof ReviewReport.Type
