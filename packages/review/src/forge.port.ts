import { Context } from "effect"
import type { Effect } from "effect"
import type { CiRun, FailedLog, FirstHead, ForgeUnreadable, RunId } from "./forge.entity.js"
import type { CommandFailed, OutputCut } from "./host-command.entity.js"
import type { CommitSha, PullNumber, PullRequest, RepoName } from "./pull-request.entity.js"

/** Why a call to the forge failed: its command failed or was cut, or its answer did not decode. */
export type ForgeError = CommandFailed | OutputCut | ForgeUnreadable

/**
 * The forge a pull request lives on, read-only. `pullRequest` answers the pull request with its files, its commits
 * and its author's permission (`none` when the forge will not say). `ciRuns` answers every CI run for a head commit
 * (a pull request's, a push's, a merge queue's), only those of the given workflow files when some are given, and
 * never one with no job. `failedLog` answers the log of a run's failed steps, or why there is none: a missing or
 * expired log is a result; an auth or repository failure is a failure with its reason. `firstHead` answers the commit
 * the pull request was first pushed at: the one its earliest `pull_request` CI run tested, else its first commit
 * (`ForgeUnreadable` for a pull request with no commit).
 */
export class Forge extends Context.Service<Forge, {
  readonly pullRequest: (repo: RepoName, number: PullNumber) => Effect.Effect<PullRequest, ForgeError>
  readonly ciRuns: (repo: RepoName, head: CommitSha, workflows: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<CiRun>, ForgeError>
  readonly firstHead: (repo: RepoName, pull: PullRequest) => Effect.Effect<FirstHead, ForgeError>
  readonly failedLog: (repo: RepoName, run: RunId) => Effect.Effect<FailedLog, ForgeError>
}>()("@xandreed/review/Forge") {}
