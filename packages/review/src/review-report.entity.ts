import { Schema } from "effect"
import { Focus, GroupRun, UngroupedFile } from "./file-group.entity.js"
import { CheckNumber, Finding, Verdict } from "./finding.entity.js"
import { Effort } from "./review-model.entity.js"
import { ReviewedAt } from "./prepare-review.entity.js"
import { PullNumber, RepoName } from "./pull-request.entity.js"
import { TurnLimits, TurnResult } from "./review-turn.entity.js"
import { Finder } from "./review-prompt.entity.js"
import { Bucket, BucketMember, BucketNumber } from "./vote.entity.js"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** The most findings a report shows; the rest are counted. */
export const FINDINGS_SHOWN = 6

/** The line above the findings no check settled, in the report a person reads. */
export const UNSETTLED_HEAD = "Unsettled: no check confirmed these and none refuted them (a check could not tell, or its quote was not found); read them before trusting either way."

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
 * One check of a bucket's finding: the bucket, the finding it was shown (`finding`, its turn and number), the check's
 * number, its verdict when it gave one, whether the verdict's quote is in the head's file within the finding's lines
 * (`quoteWithin`), the outcome, and why, in words, when it is no verdict's own.
 */
export const BucketCheck = Schema.Struct({
  bucket: BucketNumber,
  finding: BucketMember,
  check: CheckNumber,
  verdict: Schema.OptionFromNullOr(Verdict),
  quoteHolds: Schema.Boolean,
  outcome: CheckOutcome,
  why: Schema.String,
})
export type BucketCheck = typeof BucketCheck.Type

/**
 * A finding as the report shows it: the bucket's finding a check confirmed (its first confirmed, in check order; with no
 * check, the bucket's best-worded), how many finder turns found it of how many ran, why
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
 * model, how its finder turns read the pull request (`focus`) and, focused, each group with the turn that reviewed it
 * or why none did (`groups`), the files no group holds with why (`ungrouped`), what the review notes about how it ran
 * (`notes`: a package lookup that failed, a check with no cache, a fall back to the whole focus), how hard the model reasoned in each stage (`effort`), how its finder turns found (`finder`), whether
 * the vote filtered and whether checks ran; whether every stage ran
 * (`complete`: a record kept while the review runs says false, and is replaced once a stage ends); how many finder
 * turns were asked for (`turnsAsked`: more than ran when the first ended before its first call answered); each finder
 * turn (`turns`) and each check (its session, how it ended, its calls with what each used, the files it opened); every
 * finding of every turn; every
 * bucket, kept or not, with its votes; every check; the findings shown (`reported`: confirmed by a check, or the kept
 * buckets' when no check ran, sorted by severity, then path, then line); the findings no check settled (`unsettled`:
 * of each bucket no check confirmed and one judged unsure, its first unsure finding with the check's reason, the
 * host's why first when the host made it unsure, sorted the same, kept apart from the confirmed: checked alone, #644's
 * gold leak got one confirmed and one unsure verdict in two draws, and an unsure one used to be dropped); the files in
 * the packed diff against those
 * changed; what each stage's calls and all of them used; and the wall time.
 */
export const ReviewReport = Schema.Struct({
  run: Schema.String,
  repo: RepoName,
  number: PullNumber,
  at: ReviewedAt,
  promptVersion: Schema.String,
  toolsVersion: Schema.String,
  /** The tools a host added after the six (`kernelTurns`' `hostTools`), by name in the order offered: none for the six alone. */
  hostTools: Schema.Array(Schema.String),
  /** What the turns were given beyond the model (`ReviewTurns.limits`): thinking sent back, the read limit. */
  limits: TurnLimits,
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
  turnsAsked: Count,
  turns: Schema.Array(TurnResult),
  checks: Schema.Array(TurnResult),
  findings: Schema.Array(Finding),
  buckets: Schema.Array(Bucket),
  verdicts: Schema.Array(BucketCheck),
  reported: Schema.Array(ReportedFinding),
  unsettled: Schema.Array(ReportedFinding),
  packedFiles: Count,
  changedFiles: Count,
  usage: ReviewUsage,
  stages: Schema.Struct({ find: ReviewUsage, verify: ReviewUsage }),
  wallMs: Count,
})
export type ReviewReport = typeof ReviewReport.Type
