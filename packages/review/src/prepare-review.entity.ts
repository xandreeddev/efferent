import { Schema } from "effect"
import type { AttributeRule, FileStats } from "./file-verdict.entity.js"
import type { FileDiff as DiffFile } from "./diff.entity.js"
import type { Digested } from "./log-digest.entity.js"
import type { DroppedFile } from "./packed-diff.entity.js"
import type { FileGroup, GroupBounds } from "./file-group.entity.js"
import { CiRun, FirstHeadSource } from "./forge.entity.js"
import { FileVerdict } from "./file-verdict.entity.js"
import { DigestLimits, LogDigest } from "./log-digest.entity.js"
import { ValidationRan, ValidationRefused } from "./validations.entity.js"
import { PackedDiff } from "./packed-diff.entity.js"
import { CommitSha, PullRequest } from "./pull-request.entity.js"
import { FileDiff } from "./diff.entity.js"
import { RepoRules } from "./repo-rules.entity.js"

/**
 * Which commit of a pull request is reviewed: its head now (`Head`); its first head (`First`), the commit its earliest
 * `pull_request` CI run tested, or its first commit when no run is known, to compare a review with what later commits
 * fixed; or a commit given by its sha (`Sha`).
 */
export const ReviewAt = Schema.Union([
  Schema.TaggedStruct("Head", {}),
  Schema.TaggedStruct("First", {}),
  Schema.TaggedStruct("Sha", { sha: CommitSha }),
])
export type ReviewAt = typeof ReviewAt.Type

/** Where the commit under review came from: the head, one of the ways to the first head (`FirstHeadSource`), or a sha given. */
export const AtSource = Schema.Literals(["head", ...FirstHeadSource.literals, "sha"])
export type AtSource = typeof AtSource.Type

/** The words for each source, for a person: a fallback says what it may miss. */
export const AT_SOURCE_WORDS: Readonly<Record<AtSource, string>> = {
  head: "its head",
  "first-ci-run": "its first head, the commit its earliest pull_request CI run tested",
  "before-first-force-push": "the head its first force-push replaced, since no pull_request CI run of it is known; an earlier push may have come before it",
  "first-commit": "its oldest commit now, since no pull_request CI run or force-push of it is known; a rebase may have changed it",
  sha: "the commit asked for",
}

/**
 * What the pull request changed after the commit under review, for scoring a review against later fixes: its head
 * now, and the paths `<reviewed>...<head>` changes (from where the head's history left the reviewed commit, so changes
 * merged in from the base count only where they touch the same paths).
 */
export const LaterChanges = Schema.Struct({
  head: CommitSha,
  paths: Schema.Array(Schema.String),
})
export type LaterChanges = typeof LaterChanges.Type

/**
 * The commit under review (`sha`), where it came from, and the base its diff and rules are read from: the pull
 * request's base for its head; for another commit, where its history meets the base's (`git merge-base`).
 */
export const ReviewedAt = Schema.Struct({
  sha: CommitSha,
  source: AtSource,
  base: CommitSha,
})
export type ReviewedAt = typeof ReviewedAt.Type

/**
 * What a preparation is asked: which commit to review; the token budget of the diff; the commands to run by hand
 * (`run`) and whether the repository's profile runs too (`validate`; neither: nothing is run); the workflow files whose
 * CI runs count (none: every one the `pull_request` event started); the digest's limits; how long each command may
 * run, and how long each clone's whole run may take (`budgetMs`).
 */
export const PrepareOptions = Schema.Struct({
  at: ReviewAt,
  budgetTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  run: Schema.Array(Schema.String),
  validate: Schema.Boolean,
  workflows: Schema.Array(Schema.String),
  limits: DigestLimits,
  timeoutMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  budgetMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})
export type PrepareOptions = typeof PrepareOptions.Type

/** The default budget of the diff the model reads, in estimated tokens. */
export const DEFAULT_BUDGET_TOKENS = 24_000

/**
 * Why the commands asked for were not run: the head is a fork's, its author may not write to the repository, or the
 * host gave no `Validations` (a pull request's commands run only in a sandbox the host provides). A base off the
 * default branch is the validations' own refusal (`Refused`).
 */
export const SkipReason = Schema.Literals(["fork", "permission", "no-sandbox"])
export type SkipReason = typeof SkipReason.Type

/** The words for each reason. */
export const SKIPPED_BECAUSE: Readonly<Record<SkipReason, string>> = {
  fork: "the head branch is not in the base repository, so its scripts are not run",
  permission: "the author may not write to the repository, so their scripts are not run",
  "no-sandbox": "no sandbox to run them in was given, so nothing is run",
}

/**
 * The commands asked for: none asked; not run, with the reason (`Skipped` before anything was looked at, `Refused`
 * by what the base holds); or run, with the profile and a digest of each (`ValidationRan`).
 */
export const Validation = Schema.Union([
  Schema.TaggedStruct("NotAsked", {}),
  Schema.TaggedStruct("Skipped", { reason: SkipReason }),
  ValidationRefused,
  ValidationRan,
])
export type Validation = typeof Validation.Type

/**
 * A failed CI run with the digest of its failed steps' log; or why there is no log (`NoLog`: the forge no longer has
 * it); or why it could not be read (`Unavailable`: the forge refused or failed, said in its words, stripped and cut),
 * which leaves this run's entry and fails nothing else.
 */
export const FailingRun = Schema.Struct({
  run: CiRun,
  log: Schema.Union([
    Schema.TaggedStruct("Digested", { digest: LogDigest }),
    Schema.TaggedStruct("NoLog", { reason: Schema.String }),
    Schema.TaggedStruct("Unavailable", { reason: Schema.String }),
  ]),
})
export type FailingRun = typeof FailingRun.Type

/**
 * A pull request prepared for review, with no model asked: the pull request, the commit under review and its base,
 * every changed file's diff (`files`, whole), what the pull request changed after the commit under review when it is
 * not the head (`later`), each changed file's verdict, the diff packed under its budget, the repository's rules at the base commit, the CI runs of the head with a digest of each
 * failed one, and the commands asked for.
 */
export const PreparedReview = Schema.Struct({
  pullRequest: PullRequest,
  at: ReviewedAt,
  files: Schema.Array(FileDiff),
  later: Schema.OptionFromNullOr(LaterChanges),
  verdicts: Schema.Array(FileVerdict),
  diff: PackedDiff,
  rules: Schema.Array(RepoRules),
  ci: Schema.Array(CiRun),
  failing: Schema.Array(FailingRun),
  validation: Validation,
})
export type PreparedReview = typeof PreparedReview.Type

/**
 * The stages a preparation runs that are policy, not plumbing: each a pure function with a stock default
 * (`STOCK_POLICIES`), so a host swaps one without touching the others. `verdict` decides which files the model reads;
 * `pack` packs them under the budget; `rulesAlong` names the instruction files to look for; `digest` shortens a log;
 * `mayRun` says whether a pull request's commands may run at all (its head and author); `failed` says whether a CI
 * run counts as failed; `group` groups the changed files for a focused review (`groups` focus), given the folders
 * that hold a `package.json`.
 */
export interface ReviewPolicies {
  readonly group: (files: ReadonlyArray<DiffFile>, packageFolders: ReadonlySet<string>, bounds: GroupBounds, config: boolean) => ReadonlyArray<FileGroup>
  readonly verdict: (path: string, stats: FileStats, attributes: ReadonlyArray<AttributeRule>) => FileVerdict
  readonly pack: (files: ReadonlyArray<DiffFile>, budgetTokens: number, earlier: ReadonlyArray<DroppedFile>) => PackedDiff
  readonly rulesAlong: (changedPaths: ReadonlyArray<string>) => ReadonlyArray<string>
  readonly digest: (text: string, changedPaths: ReadonlyArray<string>, limits: DigestLimits) => Digested
  readonly mayRun: (pull: PullRequest) => boolean
  readonly failed: (run: CiRun) => boolean
}
