import { Effect, Match, Option, Result } from "effect"
import { clipTo } from "@xandreed/sdk"
import { Checkout } from "./checkout.port.js"
import { parseUnifiedDiff } from "./diff.entity.functions.js"
import { attributesOf } from "./file-verdict.entity.functions.js"
import { Forge } from "./forge.port.js"
import type { LogDigest } from "./log-digest.entity.js"
import { plainText } from "./log-digest.entity.functions.js"
import type { DroppedFile } from "./packed-diff.entity.js"
import type { FailingRun, LaterChanges, PrepareOptions, PreparedReview, ReviewedAt, ReviewPolicies, SkipReason, Validation } from "./prepare-review.entity.js"
import { reviewFolderOf } from "./prepare-review.entity.functions.js"
import { STOCK_POLICIES } from "./prepare-review.usecase.functions.js"
import type { PullNumber, RepoName } from "./pull-request.entity.js"
import type { RepoRules } from "./repo-rules.entity.js"
import { ReviewLogs } from "./review-logs.port.js"
import { Validations } from "./validations.port.js"

/** The longest the reason a failed log could not be read is kept, in characters. */
const UNAVAILABLE_SHOWN = 300


/**
 * Prepare a pull request for review, asking no model, each policy from `policies` (`STOCK_POLICIES` by default): read
 * it from the forge; choose the commit under review (`options.at`: the head, the first head, or a sha) and its base
 * (for a commit other than the head, where its history meets the pull request's base); fetch them; read the diff from
 * where the commit left the base, drop the files no
 * reviewer reads (`verdict`, with `.gitattributes` at the base) and pack the rest under the budget (`pack`); read the instruction files along the changed paths at the base, a text
 * met twice kept once; list the head's CI runs and digest each failed one's log, the whole log kept (a log that cannot be read is
 * that run's `Unavailable` entry and fails nothing else; the runs are those of the commit under review); and run the
 * commands asked for (by hand, and the repository's profile with `validate`) on the commit under review and its base,
 * only for a head in the base repository whose author may write to it and only through the `Validations` the host
 * provides (sandboxes over throwaway clones; with none, nothing runs and no clone is made).
 */
export const prepareReview = Effect.fn("review.prepare")(function* (repo: RepoName, number: PullNumber, options: PrepareOptions, policies: ReviewPolicies = STOCK_POLICIES) {
  const forge = yield* Forge
  const checkout = yield* Checkout
  const logs = yield* ReviewLogs
  const pull = yield* forge.pullRequest(repo, number)
  yield* checkout.fetch(repo, pull.base, { sha: pull.head.sha, fetchRef: pull.fetchRef })
  const chosen = yield* Match.valueTags(options.at, {
    Head: () => Effect.succeed({ sha: pull.head.sha, source: "head" as const }),
    First: () => forge.firstHead(repo, pull),
    Sha: ({ sha }) => Effect.succeed({ sha, source: "sha" as const }),
  })
  // The head is reviewed against the pull request's base; any other commit (the first head too, even when it is the
  // head) against where its history meets that base, after fetching it by its sha when the head's ref no longer
  // reaches it (a force-push).
  const at: ReviewedAt = options.at._tag === "Head"
    ? { sha: chosen.sha, source: chosen.source, base: pull.base.sha }
    : yield* Effect.gen(function* () {
      if (chosen.sha !== pull.head.sha) yield* checkout.fetch(repo, pull.base, { sha: chosen.sha, fetchRef: pull.fetchRef })
      return { sha: chosen.sha, source: chosen.source, base: yield* checkout.mergeBase(repo, pull.base.sha, chosen.sha) }
    })
  const files = yield* Effect.fromResult(parseUnifiedDiff(yield* checkout.diff(repo, at.base, at.sha)))
  // What later commits changed, kept for scoring a review of an earlier commit against them.
  const later: Option.Option<LaterChanges> = at.sha === pull.head.sha
    ? Option.none()
    : Option.some({ head: pull.head.sha, paths: yield* checkout.changedPaths(repo, at.sha, pull.head.sha) })
  const attributes = Option.match(yield* checkout.show(repo, at.base, ".gitattributes"), { onNone: () => [], onSome: attributesOf })
  const verdicts = files.map((file) => policies.verdict(file.path, file, attributes))
  const dropped: ReadonlyArray<DroppedFile> = verdicts.flatMap((verdict, at) => {
    const file = files[at]
    return verdict._tag === "Dropped" && file !== undefined ? [{ path: verdict.path, reason: verdict.reason, additions: file.additions, deletions: file.deletions }] : []
  })
  const kept = files.filter((_, at) => verdicts[at]?._tag === "Kept")
  const diff = policies.pack(kept, options.budgetTokens, dropped)
  const changedPaths = files.flatMap((file) => [file.path, ...Option.toArray(file.oldPath)])

  const found = yield* Effect.forEach(policies.rulesAlong(changedPaths), (path) => Effect.map(checkout.show(repo, at.base, path), (text) => ({ path, text })), { concurrency: 4 })
  const rules = found.reduce<Array<RepoRules>>((all, { path, text }) => Option.match(text, {
    onNone: () => all,
    onSome: (body) => all.some((rule) => rule.text === body) ? all : [...all, { path, text: body, from: at.base }],
  }), [])

  const ci = yield* forge.ciRuns(repo, at.sha, options.workflows)
  const folder = reviewFolderOf(pull.number, at.sha)
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
  const asked = options.run.length > 0 || options.validate
  const skipped: Option.Option<SkipReason> = !asked
    ? Option.none()
    : !pull.sameRepo
      ? Option.some("fork")
      : !policies.mayRun(pull)
        ? Option.some("permission")
        : Option.isNone(validations) ? Option.some("no-sandbox") : Option.none()
  const validation: Validation = !asked
    ? { _tag: "NotAsked" }
    : yield* Option.match(skipped, {
      onSome: (reason) => Effect.succeed<Validation>({ _tag: "Skipped", reason }),
      onNone: () => Option.match(validations, {
        onNone: () => Effect.succeed<Validation>({ _tag: "Skipped", reason: "no-sandbox" }),
        onSome: (service) => service.run({
          repo,
          base: at.base,
          head: at.sha,
          run: options.run,
          profile: options.validate,
          changedPaths,
          limits: options.limits,
          logFolder: folder,
          commandTimeoutMs: options.timeoutMs,
          budgetMs: options.budgetMs,
        }),
      }),
    })

  const prepared: PreparedReview = { pullRequest: pull, at, files, later, verdicts, diff, rules, ci, failing, validation }
  return prepared
})
