import { Schema } from "effect"
import type { AttributeRule, FileStats } from "./file-verdict.entity.js"
import type { FileDiff as DiffFile } from "./diff.entity.js"
import type { Digested } from "./log-digest.entity.js"
import type { DroppedFile } from "./packed-diff.entity.js"
import { CiRun } from "./forge.entity.js"
import { FileVerdict } from "./file-verdict.entity.js"
import { DigestLimits, LogDigest } from "./log-digest.entity.js"
import { PackedDiff } from "./packed-diff.entity.js"
import { PullRequest } from "./pull-request.entity.js"
import { RepoRules } from "./repo-rules.entity.js"

/**
 * What a preparation is asked: the token budget of the diff, the commands to run in the worktree (none: nothing is
 * run), the workflow files whose CI runs count (none: every one the `pull_request` event started), the digest's
 * limits and how long each command may run.
 */
export const PrepareOptions = Schema.Struct({
  budgetTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  run: Schema.Array(Schema.String),
  workflows: Schema.Array(Schema.String),
  limits: DigestLimits,
  timeoutMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})
export type PrepareOptions = typeof PrepareOptions.Type

/** The default budget of the diff the model reads, in estimated tokens. */
export const DEFAULT_BUDGET_TOKENS = 24_000

/**
 * Why the commands asked for were not run: the head is a fork's, its author may not write to the repository, or the
 * host gave no `Validations` (none ships: a pull request's commands run only in a sandbox the host provides).
 */
export const SkipReason = Schema.Literals(["fork", "permission", "no-sandbox"])
export type SkipReason = typeof SkipReason.Type

/** The words for each reason. */
export const SKIPPED_BECAUSE: Readonly<Record<SkipReason, string>> = {
  fork: "the head branch is not in the base repository, so its scripts are not run",
  permission: "the author may not write to the repository, so their scripts are not run",
  "no-sandbox": "no sandbox to run them in was given, so nothing is run",
}

/** The commands asked for: none asked, not run with the reason, or run with a digest of each. */
export const Validation = Schema.Union([
  Schema.TaggedStruct("NotAsked", {}),
  Schema.TaggedStruct("Skipped", { reason: SkipReason }),
  Schema.TaggedStruct("Ran", { digests: Schema.Array(LogDigest) }),
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
 * A pull request prepared for review, with no model asked: the pull request, each changed file's verdict, the diff
 * packed under its budget, the repository's rules at the base commit, the CI runs of the head with a digest of each
 * failed one, and the commands asked for.
 */
export const PreparedReview = Schema.Struct({
  pullRequest: PullRequest,
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
 * run counts as failed.
 */
export interface ReviewPolicies {
  readonly verdict: (path: string, stats: FileStats, attributes: ReadonlyArray<AttributeRule>) => FileVerdict
  readonly pack: (files: ReadonlyArray<DiffFile>, budgetTokens: number, earlier: ReadonlyArray<DroppedFile>) => PackedDiff
  readonly rulesAlong: (changedPaths: ReadonlyArray<string>) => ReadonlyArray<string>
  readonly digest: (text: string, changedPaths: ReadonlyArray<string>, limits: DigestLimits) => Digested
  readonly mayRun: (pull: PullRequest) => boolean
  readonly failed: (run: CiRun) => boolean
}
