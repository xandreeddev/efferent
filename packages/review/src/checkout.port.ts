import { Context } from "effect"
import type { Effect, Option, Scope } from "effect"
import type { BlobSha, CommitMissing, GrepHit, GrepRequest, PatternRefused, TreeEntry } from "./checkout.entity.js"
import type { CommandFailed, OutputCut } from "./host-command.entity.js"
import type { CommitSha, HeadToFetch, PullEnd, RepoName } from "./pull-request.entity.js"

/** Why a checkout failed: a git command failed or was cut, or a commit is not there after fetching. */
export type CheckoutError = CommandFailed | OutputCut | CommitMissing

/**
 * A local clone of each repository, kept between reviews. `fetch` brings the pull request's head (by the ref the forge
 * serves it under) and its base branch up to date, and fails with `CommitMissing` when either commit is still not there. `diff` answers the change from
 * where the head left the base to the head (`base...head`), whole. `show` answers a file's text at a commit, none when
 * it has no such file or the path is a link. `worktree` checks a commit out in a folder of its own for the caller's
 * scope, removed when the scope closes.
 *
 * What the model's tools read comes from the clone's objects at a commit, never from a folder on disk: `entry` says
 * what a path is in a commit's tree (a link, a submodule or a folder is never read), `blob` answers a blob's text,
 * `files` the paths of a commit's regular files, `grep` the lines of its tracked text files that hold a pattern
 * (`PatternRefused` for a regular expression git cannot read), and `mergeBase` where two commits' histories meet.
 * `entry`, `blob` and `grep` run under the host shell's small output bound (`tool`). `changedPaths` answers the paths
 * `from...to` changes (from where `to` left `from`), for a review's records.
 */
export class Checkout extends Context.Service<Checkout, {
  readonly fetch: (repo: RepoName, base: PullEnd, head: HeadToFetch) => Effect.Effect<void, CheckoutError>
  readonly diff: (repo: RepoName, base: CommitSha, head: CommitSha) => Effect.Effect<string, CheckoutError>
  readonly show: (repo: RepoName, at: CommitSha, path: string) => Effect.Effect<Option.Option<string>, CheckoutError>
  readonly worktree: (repo: RepoName, at: CommitSha) => Effect.Effect<string, CheckoutError, Scope.Scope>
  readonly entry: (repo: RepoName, at: CommitSha, path: string) => Effect.Effect<TreeEntry, CheckoutError>
  readonly blob: (repo: RepoName, blob: BlobSha) => Effect.Effect<string, CheckoutError>
  readonly files: (repo: RepoName, at: CommitSha) => Effect.Effect<ReadonlyArray<string>, CheckoutError>
  readonly grep: (repo: RepoName, at: CommitSha, request: GrepRequest) => Effect.Effect<ReadonlyArray<GrepHit>, CheckoutError | PatternRefused>
  readonly mergeBase: (repo: RepoName, one: CommitSha, other: CommitSha) => Effect.Effect<CommitSha, CheckoutError>
  readonly changedPaths: (repo: RepoName, from: CommitSha, to: CommitSha) => Effect.Effect<ReadonlyArray<string>, CheckoutError>
}>()("@xandreed/review/Checkout") {}
