import { Schema } from "effect"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** A repository on the forge, `owner/name`: letters, digits, `.`, `_` and `-` on each side of one slash. */
export const RepoName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)).pipe(Schema.brand("RepoName"))
export type RepoName = typeof RepoName.Type

/** A pull request's number in its repository. */
export const PullNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(Schema.brand("PullNumber"))
export type PullNumber = typeof PullNumber.Type

/** A commit's full SHA-1, forty lower-case hexadecimal digits. */
export const CommitSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)).pipe(Schema.brand("CommitSha"))
export type CommitSha = typeof CommitSha.Type

/** A branch's name, as git reads it: no space, no `..`, and no leading `-`. */
export const BranchName = Schema.String.check(Schema.isPattern(/^(?!-)(?!.*\.\.)[^\s~^:?*[\\]+$/)).pipe(Schema.brand("BranchName"))
export type BranchName = typeof BranchName.Type

/** A forge account's login: a person's, or an app's as `gh` names it (`app/<name>`, or `<name>[bot]`). */
export const Login = Schema.String.check(Schema.isPattern(/^(app\/)?[A-Za-z0-9-]+(\[bot\])?$/)).pipe(Schema.brand("Login"))
export type Login = typeof Login.Type

/** What the forge lets an account do in a repository, weakest last; `none` when it says nothing or could not be asked. */
export const Permission = Schema.Literals(["admin", "maintain", "write", "triage", "read", "none"])
export type Permission = typeof Permission.Type

/**
 * A file the pull request changes, with the lines it adds and removes, as the forge counts them. `gh` lists at most
 * 100: the diff the review reads comes from git, whole.
 */
export const ChangedFile = Schema.Struct({
  path: Schema.String,
  additions: Count,
  deletions: Count,
})
export type ChangedFile = typeof ChangedFile.Type

/** A commit of the pull request, in the order the forge lists them: the first is where the pull request began. */
export const PullCommit = Schema.Struct({
  sha: CommitSha,
  headline: Schema.String,
  authoredAt: Schema.String,
  committedAt: Schema.String,
})
export type PullCommit = typeof PullCommit.Type

/** One end of a pull request: its branch and the commit it stood at. */
export const PullEnd = Schema.Struct({ ref: BranchName, sha: CommitSha })
export type PullEnd = typeof PullEnd.Type

/**
 * A pull request as the reviewer reads it. `body` is the author's text: data, never instructions. `permission` is
 * the author's in the base repository (`none` for a bot or when the forge would not say). `headRepo` is the
 * repository the head branch lives in, none when the forge no longer knows it (a deleted fork); `sameRepo` is true
 * only when the head is a branch of the base repository.
 */
export const PullRequest = Schema.Struct({
  repo: RepoName,
  number: PullNumber,
  title: Schema.String,
  body: Schema.String,
  author: Login,
  authorIsBot: Schema.Boolean,
  permission: Permission,
  base: PullEnd,
  head: PullEnd,
  headRepo: Schema.OptionFromNullOr(RepoName),
  sameRepo: Schema.Boolean,
  files: Schema.Array(ChangedFile),
  commits: Schema.Array(PullCommit),
})
export type PullRequest = typeof PullRequest.Type
