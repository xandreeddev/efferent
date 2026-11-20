import { Schema } from "effect"
import { Focus, GroupRun, UngroupedFile } from "./file-group.entity.js"
import { CheckNumber, Finding, Verdict } from "./finding.entity.js"
import { Effort } from "./review-model.entity.js"
import { ReviewedAt } from "./prepare-review.entity.js"
import { PullNumber, RepoName } from "./pull-request.entity.js"
import { PassResult } from "./review-pass.entity.js"
import { Finder } from "./review-prompt.entity.js"
import { Bucket, BucketNumber } from "./vote.entity.js"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** The most findings a report shows; the rest are counted. */
export const FINDINGS_SHOWN = 6

/** The longest a finding's quoted evidence is shown in the report, in characters. */
export const EVIDENCE_SHOWN = 400

/**
 * What a check of a bucket came to: `confirmed`, `refuted` or `unsure` as its verdict said, a confirmed verdict whose
 * quote is not in the head's file near the cited lines counting as `unsure`; or `unchecked`, no verdict given (the
 * spend cap refused it, it stopped without one, its journal failed), `why` saying so.
 */
export const CheckOutcome = Schema.Literals(["confirmed", "refuted", "unsure", "unchecked"])
export type CheckOutcome = typeof CheckOutcome.Type

/**
 * One bucket's check: the bucket, the check's number, its verdict when it gave one, whether the verdict's quote is in
 * the head's file within the cited lines (`quoteWithin`), the outcome, and why, in words, when it is no verdict's own.
 */
export const BucketCheck = Schema.Struct({
  bucket: BucketNumber,
  check: CheckNumber,
  verdict: Schema.OptionFromNullOr(Verdict),
  quoteHolds: Schema.Boolean,
  outcome: CheckOutcome,
  why: Schema.String,
})
export type BucketCheck = typeof BucketCheck.Type

/**
 * A finding as the report shows it: the bucket's best-worded finding, how many passes found it of how many ran, why
 * the check confirmed it (empty when nothing was checked), and whether it only restates a failure the CI's digest
 * already names (same path and line).
 */
export const ReportedFinding = Schema.Struct({
  ...Finding.fields,
  bucket: BucketNumber,
  votes: Count,
  checked: Schema.String,
  restatesCi: Schema.Boolean,
})
export type ReportedFinding = typeof ReportedFinding.Type

/** What model calls used together: tokens read (the cached share among them) and written, and what they cost. */
export const ReviewUsage = Schema.Struct({
  input: Count,
  cached: Count,
  output: Count,
  cost: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  calls: Count,
})
export type ReviewUsage = typeof ReviewUsage.Type

/**
 * A review, as the command line prints it and keeps it beside the prepared review for offline scoring: its run (the
 * folder it is kept in), the pull request and the commit reviewed, the prompt's and the tool set's versions, the
 * model, how its passes read the pull request (`focus`) and, focused, each group with the pass that reviewed it or why
 * none did (`groups`), the files no group holds with why (`ungrouped`), what the review notes about how it ran
 * (`notes`: a package lookup that failed, a check with no cache, a fall back to the whole focus), how hard the model reasoned in each stage (`effort`), how its passes found (`finder`), whether
 * the vote filtered and whether checks ran; whether every stage ran
 * (`complete`: a record kept while the review runs says false, and is replaced once a stage ends); how many passes were
 * asked for (`passesAsked`: more than ran when the first ended before its first call answered); each pass and each check
 * (its session, how it ended, its calls with what each used, the files it opened); every finding of every pass; every
 * bucket, kept or not, with its votes; every check; the findings shown (`reported`: confirmed by a check, or the kept
 * buckets' when no check ran, sorted by severity, then path, then line); the files in the packed diff against those
 * changed; what each stage's calls and all of them used; and the wall time.
 */
export const ReviewReport = Schema.Struct({
  run: Schema.String,
  repo: RepoName,
  number: PullNumber,
  at: ReviewedAt,
  promptVersion: Schema.String,
  toolsVersion: Schema.String,
  model: Schema.String,
  focus: Focus,
  effort: Schema.Struct({ find: Effort, check: Effort }),
  groups: Schema.Array(GroupRun),
  ungrouped: Schema.Array(UngroupedFile),
  notes: Schema.Array(Schema.String),
  finder: Finder,
  vote: Schema.Boolean,
  verify: Schema.Boolean,
  complete: Schema.Boolean,
  passesAsked: Count,
  passes: Schema.Array(PassResult),
  checks: Schema.Array(PassResult),
  findings: Schema.Array(Finding),
  buckets: Schema.Array(Bucket),
  verdicts: Schema.Array(BucketCheck),
  reported: Schema.Array(ReportedFinding),
  packedFiles: Count,
  changedFiles: Count,
  usage: ReviewUsage,
  stages: Schema.Struct({ find: ReviewUsage, verify: ReviewUsage }),
  wallMs: Count,
})
export type ReviewReport = typeof ReviewReport.Type
