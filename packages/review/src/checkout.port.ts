import { Context } from "effect"
import type { Effect, Option, Scope } from "effect"
import type { CommitMissing } from "./checkout.entity.js"
import type { CommandFailed, OutputCut } from "./host-command.entity.js"
import type { CommitSha, PullEnd, PullNumber, RepoName } from "./pull-request.entity.js"

/** Why a checkout failed: a git command failed or was cut, or a commit is not there after fetching. */
export type CheckoutError = CommandFailed | OutputCut | CommitMissing

/**
 * A local clone of each repository, kept between reviews. `fetch` brings the pull request's head and its base branch
 * up to date, and fails with `CommitMissing` when either commit is still not there. `diff` answers the change from
 * where the head left the base to the head (`base...head`), whole. `show` answers a file's text at a commit, none when
 * it has no such file or the path is a link. `worktree` checks a commit out in a folder of its own for the caller's
 * scope, removed when the scope closes.
 */
export class Checkout extends Context.Service<Checkout, {
  readonly fetch: (repo: RepoName, number: PullNumber, base: PullEnd, head: CommitSha) => Effect.Effect<void, CheckoutError>
  readonly diff: (repo: RepoName, base: CommitSha, head: CommitSha) => Effect.Effect<string, CheckoutError>
  readonly show: (repo: RepoName, at: CommitSha, path: string) => Effect.Effect<Option.Option<string>, CheckoutError>
  readonly worktree: (repo: RepoName, at: CommitSha) => Effect.Effect<string, CheckoutError, Scope.Scope>
}>()("@xandreed/review/Checkout") {}
