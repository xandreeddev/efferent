import { Effect, Option, Result } from "effect"
import { clipTo } from "@xandreed/sdk"
import { Checkout } from "./checkout.port.js"
import { parseUnifiedDiff } from "./diff.entity.functions.js"
import { attributesOf } from "./file-verdict.entity.functions.js"
import { Forge } from "./forge.port.js"
import type { LogDigest } from "./log-digest.entity.js"
import { plainText } from "./log-digest.entity.functions.js"
import type { DroppedFile } from "./packed-diff.entity.js"
import type { FailingRun, PrepareOptions, PreparedReview, ReviewPolicies, SkipReason, Validation } from "./prepare-review.entity.js"
import { STOCK_POLICIES } from "./prepare-review.usecase.functions.js"
import type { PullNumber, PullRequest, RepoName } from "./pull-request.entity.js"
import type { RepoRules } from "./repo-rules.entity.js"
import { ReviewLogs } from "./review-logs.port.js"
import { Validations } from "./validations.port.js"

/** The longest the reason a failed log could not be read is kept, in characters. */
const UNAVAILABLE_SHOWN = 300

/** The folder a review's logs go in, under the repository's: the pull request and the first twelve digits of its head. */
const logFolderOf = (pull: PullRequest): string => `${pull.number}-${pull.head.sha.slice(0, 12)}`

/**
 * Prepare a pull request for review, asking no model, each policy from `policies` (`STOCK_POLICIES` by default): read
 * it from the forge; fetch its head and base; read the diff from where the head left the base, drop the files no
 * reviewer reads (`verdict`, with `.gitattributes` at the base) and pack the rest under the budget (`pack`); read the instruction files along the changed paths at the base, a text
 * met twice kept once; list the head's CI runs and digest each failed one's log, the whole log kept (a log that cannot be read is
 * that run's `Unavailable` entry and fails nothing else); and run the
 * commands asked for in a worktree of the head, only for a head in the base repository whose author may write to it
 * and only through the `Validations` the host provides (a sandbox; with none, nothing runs and no worktree is made).
 */
export const prepareReview = Effect.fn("review.prepare")(function* (repo: RepoName, number: PullNumber, options: PrepareOptions, policies: ReviewPolicies = STOCK_POLICIES) {
  const forge = yield* Forge
  const checkout = yield* Checkout
  const logs = yield* ReviewLogs
  const pull = yield* forge.pullRequest(repo, number)
  yield* checkout.fetch(repo, pull.base, { sha: pull.head.sha, fetchRef: pull.fetchRef })
  const files = yield* Effect.fromResult(parseUnifiedDiff(yield* checkout.diff(repo, pull.base.sha, pull.head.sha)))
  const attributes = Option.match(yield* checkout.show(repo, pull.base.sha, ".gitattributes"), { onNone: () => [], onSome: attributesOf })
  const verdicts = files.map((file) => policies.verdict(file.path, file, attributes))
  const dropped: ReadonlyArray<DroppedFile> = verdicts.flatMap((verdict, at) => {
    const file = files[at]
    return verdict._tag === "Dropped" && file !== undefined ? [{ path: verdict.path, reason: verdict.reason, additions: file.additions, deletions: file.deletions }] : []
  })
  const kept = files.filter((_, at) => verdicts[at]?._tag === "Kept")
  const diff = policies.pack(kept, options.budgetTokens, dropped)
  const changedPaths = files.flatMap((file) => [file.path, ...Option.toArray(file.oldPath)])

  const found = yield* Effect.forEach(policies.rulesAlong(changedPaths), (path) => Effect.map(checkout.show(repo, pull.base.sha, path), (text) => ({ path, text })), { concurrency: 4 })
  const rules = found.reduce<Array<RepoRules>>((all, { path, text }) => Option.match(text, {
    onNone: () => all,
    onSome: (body) => all.some((rule) => rule.text === body) ? all : [...all, { path, text: body, from: pull.base.sha }],
  }), [])

  const ci = yield* forge.ciRuns(repo, pull.head.sha, options.workflows)
  const folder = logFolderOf(pull)
  const failing = yield* Effect.forEach(ci.filter(policies.failed), (run) => Effect.gen(function* () {
    const read = yield* Effect.result(forge.failedLog(repo, run.id))
    if (Result.isFailure(read)) return { run, log: { _tag: "Unavailable", reason: clipTo(plainText(read.failure.message), UNAVAILABLE_SHOWN) } } satisfies FailingRun
    const log = read.success
    if (log._tag === "NoLog") return { run, log: { _tag: "NoLog", reason: log.reason } } satisfies FailingRun
    const logPath = yield* logs.keep(`${folder}/ci-${run.id}.log`, log.text)
    const digest: LogDigest = {
      source: { _tag: "Check", name: run.name, url: run.url },
      ended: `concluded ${Option.getOrElse(run.conclusion, () => "unknown")}`,
      exit: Option.none(),
      digest: policies.digest(log.text, changedPaths, options.limits),
      logPath,
    }
    return { run, log: { _tag: "Digested", digest } } satisfies FailingRun
  }), { concurrency: 2 })

  const validations = yield* Effect.serviceOption(Validations)
  const skipped: Option.Option<SkipReason> = options.run.length === 0
    ? Option.none()
    : !pull.sameRepo
      ? Option.some("fork")
      : !policies.mayRun(pull)
        ? Option.some("permission")
        : Option.isNone(validations) ? Option.some("no-sandbox") : Option.none()
  const validation: Validation = options.run.length === 0
    ? { _tag: "NotAsked" }
    : yield* Option.match(skipped, {
      onSome: (reason) => Effect.succeed<Validation>({ _tag: "Skipped", reason }),
      onNone: () => Effect.scoped(Effect.gen(function* () {
        const cwd = yield* checkout.worktree(repo, pull.head.sha)
        const digests = yield* Option.match(validations, {
          onNone: () => Effect.succeed([]),
          onSome: (service) => service.run({ commands: options.run, cwd, logFolder: folder, changedPaths, limits: options.limits, timeoutMs: options.timeoutMs }),
        })
        return { _tag: "Ran", digests } satisfies Validation
      })),
    })

  const prepared: PreparedReview = { pullRequest: pull, verdicts, diff, rules, ci, failing, validation }
  return prepared
})
