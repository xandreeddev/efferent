import { Schema } from "effect"
import { CommitSha } from "./pull-request.entity.js"

/** A CI run's id on the forge. */
export const RunId = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(Schema.brand("RunId"))
export type RunId = typeof RunId.Type

/** One check of a CI run (a job): its name, where it stands, how it ended (none while it runs) and its page. */
export const CheckRun = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.OptionFromNullOr(Schema.String),
  url: Schema.String,
})
export type CheckRun = typeof CheckRun.Type

/**
 * A CI run for a pull request's head commit: its id, its workflow's name and file, the event that started it, where
 * it stands, how it ended (none while it runs), its page and attempt, and its checks (never none: a run with no job
 * is not listed).
 */
export const CiRun = Schema.Struct({
  id: RunId,
  name: Schema.String,
  workflowPath: Schema.String,
  event: Schema.String,
  status: Schema.String,
  conclusion: Schema.OptionFromNullOr(Schema.String),
  url: Schema.String,
  attempt: Schema.Int,
  checks: Schema.Array(CheckRun),
})
export type CiRun = typeof CiRun.Type

/**
 * The log of a run's failed steps (`Log`), or why there is none (`NoLog`): the forge has none for it, or it expired.
 * An absence the review goes on without, not a failure.
 */
export const FailedLog = Schema.Union([
  Schema.TaggedStruct("Log", { text: Schema.String }),
  Schema.TaggedStruct("NoLog", { reason: Schema.String }),
])
export type FailedLog = typeof FailedLog.Type

/** What the forge answered does not read as what was asked for: the command and what did not decode. */
export class ForgeUnreadable extends Schema.TaggedError<ForgeUnreadable>()("ForgeUnreadable", {
  command: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** Where a pull request's first head was found: the earliest `pull_request` CI run's commit, or its first commit. */
export const FirstHeadSource = Schema.Literals(["first-ci-run", "first-commit"])
export type FirstHeadSource = typeof FirstHeadSource.Type

/** A pull request's first head: the commit it was first pushed at, and where that was found. */
export const FirstHead = Schema.Struct({ sha: CommitSha, source: FirstHeadSource })
export type FirstHead = typeof FirstHead.Type

/** A `pull_request` CI run of a head branch, as far as finding the first head needs: the commit it tested and when it started. */
export const BranchRun = Schema.Struct({ sha: Schema.String, createdAt: Schema.String })
export type BranchRun = typeof BranchRun.Type
