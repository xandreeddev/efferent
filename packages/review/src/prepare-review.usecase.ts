import { Effect, Option } from "effect"
import { Checkout } from "./checkout.port.js"
import { parseUnifiedDiff } from "./diff.entity.functions.js"
import { attributesOf, fileVerdict } from "./file-verdict.entity.functions.js"
import type { CiRun } from "./forge.entity.js"
import { Forge } from "./forge.port.js"
import type { LogDigest } from "./log-digest.entity.js"
import { digestLog } from "./log-digest.entity.functions.js"
import type { DroppedFile } from "./packed-diff.entity.js"
import { packDiff } from "./packed-diff.entity.functions.js"
import type { FailingRun, PrepareOptions, PreparedReview, Validation } from "./prepare-review.entity.js"
import type { PullNumber, PullRequest, RepoName } from "./pull-request.entity.js"
import type { RepoRules } from "./repo-rules.entity.js"
import { rulesAlong } from "./repo-rules.entity.functions.js"
import { ReviewLogs } from "./review-logs.port.js"
import { Validations } from "./validations.port.js"

/** The conclusions of a CI run that are not a failure: everything else (failure, timed out, cancelled…) is one. */
const PASSING = ["success", "skipped", "neutral"]

/** Whether a finished run failed. A run still going has no conclusion and is not read yet. */
const failed = (run: CiRun): boolean => Option.match(run.conclusion, { onNone: () => false, onSome: (conclusion) => !PASSING.includes(conclusion) })

/** The permissions that let an author's scripts run on the host. */
const WRITERS = ["admin", "maintain", "write"]

/** The folder a review's logs go in, under the repository's: the pull request and the first twelve digits of its head. */
const logFolderOf = (pull: PullRequest): string => `${pull.number}-${pull.head.sha.slice(0, 12)}`

/**
 * Prepare a pull request for review, asking no model: read it from the forge; fetch its head and base; read the diff
 * from where the head left the base, drop the files no reviewer reads (`fileVerdict`, with `.gitattributes` at the
 * base) and pack the rest under the budget; read the instruction files along the changed paths at the base, a text
 * met twice kept once; list the head's CI runs and digest each failed one's log, the whole log kept; and run the
 * commands asked for in a worktree of the head, only for a head in the base repository whose author may write to it.
 */
export const prepareReview = Effect.fn("review.prepare")(function* (repo: RepoName, number: PullNumber, options: PrepareOptions) {
  const forge = yield* Forge
  const checkout = yield* Checkout
  const logs = yield* ReviewLogs
  const pull = yield* forge.pullRequest(repo, number)
  yield* checkout.fetch(repo, number, pull.base, pull.head.sha)
  const files = yield* Effect.fromResult(parseUnifiedDiff(yield* checkout.diff(repo, pull.base.sha, pull.head.sha)))
  const attributes = Option.match(yield* checkout.show(repo, pull.base.sha, ".gitattributes"), { onNone: () => [], onSome: attributesOf })
  const verdicts = files.map((file) => fileVerdict(file.path, file, attributes))
  const dropped: ReadonlyArray<DroppedFile> = verdicts.flatMap((verdict, at) => {
    const file = files[at]
    return verdict._tag === "Dropped" && file !== undefined ? [{ path: verdict.path, reason: verdict.reason, additions: file.additions, deletions: file.deletions }] : []
  })
  const kept = files.filter((_, at) => verdicts[at]?._tag === "Kept")
  const diff = packDiff(kept, options.budgetTokens, dropped)
  const changedPaths = files.flatMap((file) => [file.path, ...Option.toArray(file.oldPath)])

  const found = yield* Effect.forEach(rulesAlong(changedPaths), (path) => Effect.map(checkout.show(repo, pull.base.sha, path), (text) => ({ path, text })), { concurrency: 4 })
  const rules = found.reduce<Array<RepoRules>>((all, { path, text }) => Option.match(text, {
    onNone: () => all,
    onSome: (body) => all.some((rule) => rule.text === body) ? all : [...all, { path, text: body, from: pull.base.sha }],
  }), [])

  const ci = yield* forge.ciRuns(repo, pull.head.sha, options.workflows)
  const folder = logFolderOf(pull)
  const failing = yield* Effect.forEach(ci.filter(failed), (run) => Effect.gen(function* () {
    const log = yield* forge.failedLog(repo, run.id)
    if (log._tag === "NoLog") return { run, log: { _tag: "NoLog", reason: log.reason } } satisfies FailingRun
    const logPath = yield* logs.keep(`${folder}/ci-${run.id}.log`, log.text)
    const digest: LogDigest = {
      source: { _tag: "Check", name: run.name, url: run.url },
      ended: `concluded ${Option.getOrElse(run.conclusion, () => "unknown")}`,
      exit: Option.none(),
      digest: digestLog(log.text, changedPaths, options.limits),
      logPath,
    }
    return { run, log: { _tag: "Digested", digest } } satisfies FailingRun
  }), { concurrency: 2 })

  const validation: Validation = options.run.length === 0
    ? { _tag: "NotAsked" }
    : !pull.sameRepo
      ? { _tag: "Skipped", reason: "fork" }
      : !WRITERS.includes(pull.permission)
        ? { _tag: "Skipped", reason: "permission" }
        : { _tag: "Ran", digests: yield* Effect.scoped(Effect.gen(function* () {
          const cwd = yield* checkout.worktree(repo, pull.head.sha)
          const validations = yield* Validations
          return yield* validations.run({ commands: options.run, cwd, logFolder: folder, changedPaths, limits: options.limits, timeoutMs: options.timeoutMs })
        })) }

  const prepared: PreparedReview = { pullRequest: pull, verdicts, diff, rules, ci, failing, validation }
  return prepared
})
