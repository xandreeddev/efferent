import { Array as Arr, Option, Order, Schema } from "effect"
import type { BranchRun, FirstHead, PullTimeline } from "./forge.entity.js"
import { CommitSha } from "./pull-request.entity.js"
import type { PullCommit } from "./pull-request.entity.js"

/** A run or an event, by when it started and the commit it names. */
interface Started {
  readonly createdAt: string
  readonly sha: string
}

/** A run's or an event's order: by when it started, then by its sha. */
const byStart: Order.Order<Started> = Order.combine(
  Order.mapInput(Order.String, (one: Started) => one.createdAt),
  Order.mapInput(Order.String, (one: Started) => one.sha),
)

/**
 * A pull request's first head. First, the commit of the earliest `pull_request` run of its head branch started while
 * it was open (from `timeline.opened` to `timeline.closed`), whether or not that commit is still in its list: a
 * force-push drops it from the list, never from the runs, and the window passes over another pull request's runs on a
 * branch of the same name. With no such run, the head its first force-push replaced; else its first commit; none when
 * it has no commit. A time is ISO 8601 in UTC, which orders as text.
 */
export const firstHeadOf = (runs: ReadonlyArray<BranchRun>, timeline: PullTimeline, commits: ReadonlyArray<PullCommit>): Option.Option<FirstHead> => {
  const open = runs.filter((run) => run.createdAt >= timeline.opened && Option.match(timeline.closed, { onNone: () => true, onSome: (closed) => run.createdAt <= closed }))
  const shaOf = (text: string) => Schema.decodeUnknownOption(CommitSha)(text)
  const ran = Arr.head(Arr.sort(open.flatMap((run) => Option.toArray(Option.map(shaOf(run.sha), (sha) => ({ createdAt: run.createdAt, sha })))), byStart))
  const replaced = Arr.head(Arr.sort(timeline.forcePushes.flatMap((push) => Option.toArray(Option.map(Option.flatMap(push.before, shaOf), (sha) => ({ createdAt: push.at, sha })))), byStart))
  return Option.match(ran, {
    onSome: (run) => Option.some<FirstHead>({ sha: run.sha, source: "first-ci-run" }),
    onNone: () => Option.match(replaced, {
      onSome: (push) => Option.some<FirstHead>({ sha: push.sha, source: "before-first-force-push" }),
      onNone: () => Option.map(Arr.head(commits), (first): FirstHead => ({ sha: first.sha, source: "first-commit" })),
    }),
  })
}
