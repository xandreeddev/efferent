import { Array as Arr, Clock, Deferred, Effect, Fiber, Match, Option, Result, Schema } from "effect"
import { ModelSpend } from "@xandreed/core"
import { Checkout } from "./checkout.port.js"
import { CheckNumber, PassNumber } from "./finding.entity.js"
import type { Verdict } from "./finding.entity.js"
import { Findings } from "./findings.port.js"
import { PreparedReview } from "./prepare-review.entity.js"
import type { ReviewPolicies } from "./prepare-review.entity.js"
import { reviewFolderOf } from "./prepare-review.entity.functions.js"
import { STOCK_POLICIES } from "./prepare-review.usecase.functions.js"
import { prepareReview } from "./prepare-review.usecase.js"
import type { PullNumber, RepoName } from "./pull-request.entity.js"
import { ReviewLogs } from "./review-logs.port.js"
import { INCOMPLETE_BECAUSE } from "./review-pass.entity.js"
import type { PassEnded, PassResult } from "./review-pass.entity.js"
import { ReviewPasses } from "./review-pass.port.js"
import { REVIEW_PROMPT } from "./review-prompt.entity.js"
import { reviewPrefix, reviewPrompt, verifyPrompt, walkOrders } from "./review-prompt.entity.functions.js"
import { ReviewReport } from "./review-report.entity.js"
import type { BucketCheck } from "./review-report.entity.js"
import { reviewReport, runNameOf } from "./review-report.entity.functions.js"
import { REVIEW_TOOLS_VERSION } from "./review-tools.entity.js"
import { treePath } from "./review-tools.entity.functions.js"
import type { ReviewOptions } from "./review.entity.js"
import { stageSpend } from "./stage-spend.adapter.js"
import type { Bucket } from "./vote.entity.js"
import { CHECK_ORDER, mergeFindings, quoteWithin } from "./vote.entity.functions.js"
import type { CommitSha } from "./pull-request.entity.js"

/** Write a value as JSON through its schema; a value of the review's own that does not encode is a defect. */
const jsonOf = <A, I>(schema: Schema.Codec<A, I>, value: A) =>
  Effect.map(Effect.orDie(Schema.encodeEffect(schema)(value)), (encoded) => `${JSON.stringify(encoded, null, 2)}\n`)

/** Why a check gave no verdict, in words, from how it ended. */
const uncheckedWhy = (ended: PassEnded): string => Match.valueTags(ended, {
  Answered: () => "it answered without a verdict",
  Judged: () => "its verdict was not kept",
  StepCap: () => INCOMPLETE_BECAUSE.StepCap,
  SpendRefused: () => INCOMPLETE_BECAUSE.SpendRefused,
  ModelFailed: () => INCOMPLETE_BECAUSE.ModelFailed,
  OutputCut: () => INCOMPLETE_BECAUSE.OutputCut,
  JournalFailed: () => INCOMPLETE_BECAUSE.JournalFailed,
})

/** Whether a verdict's quote is in the head's file within the cited lines (`quoteWithin`); a file that cannot be read is no. */
const quoteHolds = (repo: RepoName, at: CommitSha, bucket: Bucket, verdict: Verdict) => Effect.gen(function* () {
  const checkout = yield* Checkout
  const path = treePath(bucket.path)
  if (Result.isFailure(path)) return false
  const entry = yield* checkout.entry(repo, at, path.success)
  if (entry._tag !== "File") return false
  const text = yield* checkout.blob(repo, entry.blob)
  return quoteWithin(text, verdict.quote, bucket.line, bucket.endLine)
}).pipe(Effect.catch((error) => Effect.logWarning("a verdict's quote could not be checked", error).pipe(Effect.as(false))))

/** A check's outcome: its verdict's, a confirmed one whose quote fails counting as unsure; no verdict, unchecked. */
const checkOf = (bucket: Bucket, check: CheckNumber, result: PassResult, verdict: Option.Option<Verdict>, holds: boolean): BucketCheck => Option.match(verdict, {
  onNone: () => ({ bucket: bucket.number, check, verdict, quoteHolds: false, outcome: "unchecked", why: uncheckedWhy(result.ended) }),
  onSome: (given) => given.outcome === "confirmed" && !holds
    ? { bucket: bucket.number, check, verdict, quoteHolds: holds, outcome: "unsure", why: "its quote is not in the file near the cited lines" }
    : { bucket: bucket.number, check, verdict, quoteHolds: holds, outcome: given.outcome, why: "" },
})

/**
 * Review a pull request: prepare it (`prepareReview`, at the commit `options.prepare.at` names), then find, merge and
 * check, each model call charged to the review's ledger under its stage's cap (`stageSpend`: `budget.find` for the
 * passes, `budget.verify` for the checks, both inside `budget.total`).
 *
 * - Find: `passes` passes (`ReviewPasses`), each walking the changed files in its own order (`walkOrders`) with the
 *   tail of `finder`; the first runs alone until its first call returns, having written the provider's cache of the
 *   shared prefix, then the others run beside it.
 * - Merge: every finding into buckets (`mergeFindings`), the vote filtering them only when `vote` is on.
 * - Check (when `verify` is on): one check per kept bucket, best first (`CHECK_ORDER`), `verifyConcurrency` at once,
 *   each asked to refute the bucket's best finding and answer with `verdict`; a confirmed verdict whose quote is not in
 *   the head's file near the cited lines counts as unsure; a check the budget refused is unchecked.
 *
 * Each run has a folder of its own (`<number>/<sha>/<run>/` in `ReviewLogs`), so a rerun never writes over one before
 * it; it keeps, for offline scoring, the prepared review (`prepared.json`), each pass's and check's journal
 * (`pass-N/`, `check-N/`) and the report (`review.json`: every finding, bucket and check, each call's tokens and cost).
 */
export const reviewPullRequest = Effect.fn("review.review")(function* (repo: RepoName, number: PullNumber, options: ReviewOptions, policies: ReviewPolicies = STOCK_POLICIES) {
  const started = yield* Clock.currentTimeMillis
  const logs = yield* ReviewLogs
  const passes = yield* ReviewPasses
  const findings = yield* Findings
  const prepared = yield* prepareReview(repo, number, options.prepare, policies)
  const run = runNameOf(started)
  const folder = `${reviewFolderOf(prepared.pullRequest.number, prepared.at.sha)}/${run}`
  yield* logs.keep(`${folder}/prepared.json`, yield* jsonOf(PreparedReview, prepared))

  const ledger = yield* ModelSpend
  const total = yield* stageSpend(ledger, Option.some(options.budget.total))
  const findSpend = yield* stageSpend(total, Option.some(options.budget.find))
  const verifySpend = yield* stageSpend(total, Option.some(options.budget.verify))
  const orders = walkOrders(prepared, options.passes)

  const find = (index: number, onFirstAnswer?: Effect.Effect<void>) => Effect.gen(function* () {
    const pass = PassNumber.make(index + 1)
    return yield* passes.run({
      prompt: reviewPrompt(prepared, { finder: options.finder, order: orders[index] ?? [] }),
      reviewed: { repo, at: prepared.at.sha, files: prepared.files, stage: { _tag: "Find", pass } },
      journalAt: yield* logs.folder(`${folder}/pass-${pass}`),
      options: options.pass,
      spend: findSpend,
      ...(onFirstAnswer === undefined ? {} : { onFirstAnswer }),
    })
  })
  const firstAnswered = yield* Deferred.make<void>()
  // Whatever becomes of the first pass (a folder that cannot be made, a defect), the others are let go, and its
  // failure is the review's when it is joined.
  const first = yield* Effect.forkChild(find(0, Deferred.succeed(firstAnswered, undefined).pipe(Effect.asVoid)).pipe(Effect.ensuring(Deferred.succeed(firstAnswered, undefined))))
  yield* Deferred.await(firstAnswered)
  const others = yield* Effect.forEach(Arr.range(1, options.passes - 1).filter((index) => index < options.passes), (index) => find(index), { concurrency: "unbounded" })
  const found = [yield* Fiber.join(first), ...others]

  const all = yield* findings.all
  const buckets = mergeFindings(all, prepared.files, { vote: options.vote })
  const prefix = reviewPrefix(prepared)
  const toCheck = options.verify ? Arr.sort(buckets.filter((bucket) => bucket.kept), CHECK_ORDER) : []
  const checked = yield* Effect.forEach(toCheck, (bucket, index) => Effect.gen(function* () {
    const check = CheckNumber.make(index + 1)
    const result = yield* passes.run({
      prompt: verifyPrompt(prefix, bucket.best),
      reviewed: { repo, at: prepared.at.sha, files: prepared.files, stage: { _tag: "Verify", check } },
      journalAt: yield* logs.folder(`${folder}/check-${check}`),
      options: { maxSteps: options.verifySteps },
      spend: verifySpend,
    })
    const verdict = yield* findings.verdictOf(check)
    const holds = Option.isSome(verdict) ? yield* quoteHolds(repo, prepared.at.sha, bucket, verdict.value) : false
    return { result, check: checkOf(bucket, check, result, verdict, holds) }
  }), { concurrency: options.verifyConcurrency })

  const report = reviewReport({
    run,
    prepared,
    finder: options.finder,
    vote: options.vote,
    verify: options.verify,
    passes: found,
    checks: checked.map((one) => one.result),
    findings: all,
    buckets,
    verdicts: checked.map((one) => one.check),
    promptVersion: REVIEW_PROMPT,
    toolsVersion: REVIEW_TOOLS_VERSION,
    model: options.model,
    wallMs: (yield* Clock.currentTimeMillis) - started,
  })
  yield* logs.keep(`${folder}/review.json`, yield* jsonOf(ReviewReport, report))
  return report
})
