import { Array as Arr, Option, Order } from "effect"
import type { BranchRun, FirstHead } from "./forge.entity.js"
import type { PullCommit } from "./pull-request.entity.js"

/**
 * A pull request's first head: the commit of the earliest `pull_request` run (by its start, then its sha) among the
 * runs that tested one of the pull request's commits, so a branch's runs for another pull request are passed over;
 * else the first commit of its list; none when it has no commit.
 */
export const firstHeadOf = (runs: ReadonlyArray<BranchRun>, commits: ReadonlyArray<PullCommit>): Option.Option<FirstHead> => {
  const ours = runs.flatMap((run) => {
    const commit = commits.find((one) => one.sha === run.sha)
    return commit === undefined ? [] : [{ run, sha: commit.sha }]
  })
  const byStart = Order.combine(Order.mapInput(Order.String, (one: (typeof ours)[number]) => one.run.createdAt), Order.mapInput(Order.String, (one: (typeof ours)[number]) => one.sha))
  return Option.match(Arr.head(Arr.sort(ours, byStart)), {
    onSome: (earliest) => Option.some<FirstHead>({ sha: earliest.sha, source: "first-ci-run" }),
    onNone: () => Option.map(Arr.head(commits), (first): FirstHead => ({ sha: first.sha, source: "first-commit" })),
  })
}
