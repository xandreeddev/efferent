import { Array as Arr, Cause, Clock, Deferred, Effect, Fiber, Match, Option, Random, Result, Schema } from "effect"
import { ModelSpend } from "@xandreed/core"
import { clipTo } from "@xandreed/sdk"
import { Checkout } from "./checkout.port.js"
import { NO_GROUP_NOTE, NOT_REVIEWED_BECAUSE } from "./file-group.entity.js"
import type { Focus, GroupRun } from "./file-group.entity.js"
import { firstCallHold, lookupFailedNote, orderGroups, packageFoldersToLook, uncachedCheckNote, ungroupedOf } from "./file-group.entity.functions.js"
import { CheckNumber, PassNumber } from "./finding.entity.js"
import type { Finding, Verdict } from "./finding.entity.js"
import type { PassOptions } from "./review-pass.entity.js"
import type { PromptPart, ReviewPrompt } from "./review-prompt.entity.js"
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
import { focusPrefix, focusPrompt, reviewPrefix, reviewPrompt, verifyPrompt, walkOrders } from "./review-prompt.entity.functions.js"
import { ReviewReport } from "./review-report.entity.js"
import type { BucketCheck } from "./review-report.entity.js"
import { reviewReport, runNameOf } from "./review-report.entity.functions.js"
import type { ReportInput } from "./review-report.entity.functions.js"
import { REVIEW_TOOLS_VERSION } from "./review-tools.entity.js"
import type { ReviewStage } from "./review-tools.entity.js"
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
  Failed: () => INCOMPLETE_BECAUSE.Failed,
})

/** Whether a verdict's quote is in the head's file within the cited lines (`quoteWithin`); a file that cannot be read is no. */
const quoteHolds = (repo: RepoName, at: CommitSha, bucket: Bucket, verdict: Verdict) => Effect.gen(function* () {
  const checkout = yield* Checkout
  const path = treePath(bucket.path)
  if (Result.isFailure(path)) return false
  const entry = yield* checkout.entry(repo, at, path.success)
  if (entry._tag !== "File") return false
  const text = yield* checkout.blob(repo, entry.blob)
  // The lines the check was shown: the bucket's best finding's.
  return quoteWithin(text, verdict.quote, bucket.best.line, bucket.best.endLine ?? bucket.best.line)
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
 * - Find, `focus` `whole`: `passes` passes (`ReviewPasses`), each walking the changed files in its own order
 *   (`walkOrders`) with the tail of `finder`; the first runs alone until its first call returns, having written the
 *   provider's cache of the shared prefix, then the others run beside it.
 * - Find, `focus` `groups`: the changed files grouped (`policies.group`, by package, given the folders holding a
 *   `package.json` at the commit under review), one pass a group in their order, one after another, each sending its
 *   group's prefix (`focusPrefix`) and the finder's words, capped at `groups.steps` calls and keeping its closing
 *   reserve back; a group starts only while the find stage has `GROUP_START_ROOM` neither settled nor held, else it
 *   and the rest are recorded as not reviewed.
 * - Merge: every finding into buckets (`mergeFindings`), the vote filtering them only when `vote` is on.
 * - Check (when `verify` is on): one check per kept bucket, best first (`CHECK_ORDER`), `verifyConcurrency` at once,
 *   each asked to refute the bucket's best finding and answer with `verdict`, on the prefix of the group holding the
 *   finding's file (else of the group whose pass reported it; the whole review's prefix when unfocused), so its request
 *   starts with that pass's bytes; a confirmed verdict whose quote is not in
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
  const { run, folder } = yield* freshRun(reviewFolderOf(prepared.pullRequest.number, prepared.at.sha), started)
  yield* logs.keep(`${folder}/prepared.json`, yield* jsonOf(PreparedReview, prepared))
  const grouping = options.focus === "groups" ? yield* reviewGroups(repo, prepared, options, policies) : { focused: [], ungrouped: [], notes: [] }
  // The focus the review runs: the whole one when there is no group to review.
  const focus: Focus = options.focus === "groups" && grouping.focused.length > 0 ? "groups" : "whole"
  const notes: Array<string> = [...grouping.notes, ...(options.focus === "groups" && focus === "whole" ? [NO_GROUP_NOTE] : [])]
  const groupRuns: Array<GroupRun> = []
  const found: Array<PassResult> = []

  /** The report as it stands, kept as `review.json` (whole or not at all), `complete` once every stage ran. */
  const record = (parts: Pick<ReportInput, "passes" | "groups" | "checks" | "findings" | "buckets" | "verdicts" | "complete">) => Effect.gen(function* () {
    const report = reviewReport({
      ...parts,
      run,
      prepared,
      focus,
      ungrouped: focus === "groups" ? grouping.ungrouped : [],
      notes: [...notes],
      effort: options.effort,
      finder: options.finder,
      vote: options.vote,
      verify: options.verify,
      passesAsked: focus === "groups" ? parts.passes.length : options.passes,
      promptVersion: REVIEW_PROMPT,
      toolsVersion: REVIEW_TOOLS_VERSION,
      model: options.model,
      wallMs: (yield* Clock.currentTimeMillis) - started,
    })
    yield* logs.keep(`${folder}/review.json`, yield* jsonOf(ReviewReport, report))
    return report
  })
  yield* record({ passes: [], groups: [], checks: [], findings: [], buckets: [], verdicts: [], complete: false })

  const ledger = yield* ModelSpend
  const total = yield* stageSpend(ledger, Option.some(options.budget.total))
  const findSpend = yield* stageSpend(total, Option.some(options.budget.find))
  const verifySpend = yield* stageSpend(total, Option.some(options.budget.verify))
  const orders = walkOrders(prepared, options.passes)
  // What a lone pass keeps back for its closing call: at most half the find stage. Passes beside each other keep
  // nothing back, since each one's reserve would crowd out the others' calls (three keeping a sixth each end refused).
  const passOptions = { ...options.pass, reserve: options.passes === 1 ? Math.min(options.pass.reserve, options.budget.find / 2) : 0 }

  const find = (index: number, prompt: ReviewPrompt, runAs: PassOptions, onFirstAnswer?: (answered: boolean) => Effect.Effect<void>) => {
    const stage: ReviewStage = { _tag: "Find", pass: PassNumber.make(index + 1) }
    return Effect.gen(function* () {
      return yield* passes.run({
        prompt,
        reviewed: { run, repo, at: prepared.at.sha, files: prepared.files, stage },
        journalAt: yield* logs.folder(`${folder}/pass-${index + 1}`),
        options: runAs,
        spend: findSpend,
        ...(onFirstAnswer === undefined ? {} : { onFirstAnswer }),
      })
    }).pipe(Effect.catchCause(couldNotRun(stage)))
  }

  // Focused: one pass a group, one after another, each with its group's prefix; a group starts only while the find
  // stage has its closing reserve and its first call's hold (`firstCallHold`, from its prompt's size) neither settled
  // nor held, so a pass that starts can always close and report; else it and every group after it are listed as not
  // reviewed. A pass the stage refused does not stop the next: its own reserve, held beside its call, is what crowded it
  // out (on #657 the second group's eighth call was refused with $0.08 of the stage left). A pass none of whose calls
  // answered reviewed nothing: its group is listed as not reviewed, and the groups after it too. With no group to
  // review (a pull request of config, CI or docs alone), the review falls back to the whole focus.
  if (focus === "groups") {
    const runAs: PassOptions = { maxSteps: options.groups.steps, reserve: Math.min(options.groups.reserve, options.budget.find / 2) }
    let stopped = ""
    for (const { group, prefix } of grouping.focused) {
      const prompt = focusPrompt(prefix, options.finder)
      if (stopped.length === 0) {
        const totals = yield* Effect.orDie(findSpend.totals)
        if (options.budget.find - totals.settled - totals.reserved < runAs.reserve + firstCallHold(prompt, options.price)) stopped = NOT_REVIEWED_BECAUSE.spent
      }
      if (stopped.length > 0) {
        groupRuns.push({ group, pass: Option.none(), notReviewed: stopped })
        continue
      }
      const pass = PassNumber.make(found.length + 1)
      const result = yield* find(found.length, prompt, runAs)
      found.push(result)
      const answered = result.calls.some((call) => Option.isSome(call.tokens))
      groupRuns.push({ group, pass: Option.some(pass), notReviewed: answered ? "" : NOT_REVIEWED_BECAUSE.noCall })
      if (!answered) stopped = NOT_REVIEWED_BECAUSE.stopped
      yield* record({ passes: found, groups: groupRuns, checks: [], findings: yield* findings.all(run), buckets: [], verdicts: [], complete: false })
    }
  } else {
    const firstAnswered = yield* Deferred.make<boolean>()
    const whole = (index: number) => reviewPrompt(prepared, { finder: options.finder, order: orders[index] ?? [] })
    // Whatever becomes of the first pass, the review learns whether it answered; the others start only if it did.
    const first = yield* Effect.forkChild(find(0, whole(0), passOptions, (answered) => Deferred.succeed(firstAnswered, answered).pipe(Effect.asVoid)).pipe(Effect.ensuring(Deferred.succeed(firstAnswered, false))))
    const answered = yield* Deferred.await(firstAnswered)
    const others = answered ? yield* Effect.forEach(Arr.range(1, options.passes - 1).filter((index) => index < options.passes), (index) => find(index, whole(index), passOptions), { concurrency: "unbounded" }) : []
    found.push(yield* Fiber.join(first), ...others)
  }

  const all = yield* findings.all(run)
  const buckets = mergeFindings(all, prepared.files, { vote: options.vote })
  yield* record({ passes: found, groups: groupRuns, checks: [], findings: all, buckets, verdicts: [], complete: false })
  const wholePrefix = reviewPrefix(prepared)
  /**
   * A check's prefix: in a focused review, that of the group holding the finding's file, else of the group whose pass
   * reported it, so the check's request starts with that pass's bytes; else the whole review's. A check on the prefix
   * of a group whose pass never answered (not reviewed) has no cache to read, and the report notes it.
   */
  const prefixOf = (finding: Finding, check: CheckNumber): ReadonlyArray<PromptPart> => {
    const reporter = groupRuns.find((one) => Option.contains(one.pass, finding.pass))
    const holding = grouping.focused.find((one) => one.group.paths.includes(finding.path)) ?? grouping.focused.find((one) => reporter !== undefined && one.group.number === reporter.group.number)
    if (holding === undefined) return wholePrefix
    const ran = groupRuns.find((one) => one.group.number === holding.group.number)
    if (ran === undefined || ran.notReviewed.length > 0) notes.push(uncachedCheckNote(check, holding.group.number))
    return holding.prefix
  }
  const toCheck = options.verify ? Arr.sort(buckets.filter((bucket) => bucket.kept), CHECK_ORDER) : []
  const checkPrefixes = toCheck.map((bucket, index) => prefixOf(bucket.best, CheckNumber.make(index + 1)))
  // What a check keeps back for its closing call when it runs alone (one at a time, or the only one): at most half the
  // verify stage. Checks beside each other keep nothing back, for the reason passes do: under $0.20, three checks each
  // keeping a call's hold (about $0.09 at a long pull request's size) would leave no room for their own calls.
  const checkReserve = Math.min(options.verifyConcurrency, toCheck.length) === 1 ? Math.min(options.pass.reserve, options.budget.verify / 2) : 0
  const checked = yield* Effect.forEach(toCheck, (bucket, index) => {
    const check = CheckNumber.make(index + 1)
    const stage: ReviewStage = { _tag: "Verify", check }
    return Effect.gen(function* () {
      const result = yield* passes.run({
        prompt: verifyPrompt(checkPrefixes[index] ?? wholePrefix, bucket.best),
        reviewed: { run, repo, at: prepared.at.sha, files: prepared.files, stage },
        journalAt: yield* logs.folder(`${folder}/check-${check}`),
        options: { maxSteps: options.verifySteps, reserve: checkReserve },
        spend: verifySpend,
      })
      return result
    }).pipe(Effect.catchCause(couldNotRun(stage)), Effect.flatMap((result) => Effect.gen(function* () {
      const verdict = yield* findings.verdictOf(run, check)
      const holds = Option.isSome(verdict) ? yield* quoteHolds(repo, prepared.at.sha, bucket, verdict.value) : false
      return { result, check: checkOf(bucket, check, result, verdict, holds) }
    })))
  }, { concurrency: options.verifyConcurrency })

  return yield* record({ passes: found, groups: groupRuns, checks: checked.map((one) => one.result), findings: all, buckets, verdicts: checked.map((one) => one.check), complete: true })
})

/**
 * Whether the commit under review holds a regular `package.json` in `folder` (`""`, the root); none when the lookup
 * failed (logged), which the review notes rather than read as no.
 */
const holdsPackage = (repo: RepoName, at: CommitSha, folder: string) => Effect.gen(function* () {
  const checkout = yield* Checkout
  const path = treePath(folder === "" ? "package.json" : `${folder}/package.json`)
  if (Result.isFailure(path)) return Option.some(false)
  return Option.some((yield* checkout.entry(repo, at, path.success))._tag === "File")
}).pipe(Effect.catch((error) => Effect.logWarning("a package.json could not be looked up", error).pipe(Effect.as(Option.none<boolean>()))))

/**
 * A focused review's groups (`policies.group` over the files the verdict kept, given the folders that hold a
 * `package.json` at the commit under review), in the order `groups.order` says (`orderGroups`), each with its prefix
 * (`focusPrefix`, its diffs under the preparation's token budget); the files no group holds, with why
 * (`ungroupedOf`); and a note for each folder whose `package.json` could not be looked up.
 */
const reviewGroups = (repo: RepoName, prepared: PreparedReview, options: ReviewOptions, policies: ReviewPolicies) => Effect.gen(function* () {
  const left = new Set(prepared.diff.dropped.filter((file) => file.reason !== "over-budget").map((file) => file.path))
  const read = prepared.files.filter((file) => !left.has(file.path))
  const looked = yield* Effect.forEach(packageFoldersToLook(read.map((file) => file.path)), (folder) => Effect.map(holdsPackage(repo, prepared.at.sha, folder), (holds) => ({ folder, holds })), { concurrency: 4 })
  const roots = new Set(looked.filter((one) => Option.contains(one.holds, true)).map((one) => one.folder))
  const groups = orderGroups(policies.group(read, roots, options.groups.bounds, options.groups.config), read, options.groups.order)
  const byPath = new Map(read.map((file) => [file.path, file]))
  return {
    focused: groups.map((group) => ({
      group,
      prefix: focusPrefix(prepared, group.paths.flatMap((path) => Option.toArray(Option.fromNullishOr(byPath.get(path)))), options.prepare.budgetTokens),
    })),
    ungrouped: ungroupedOf(read, groups),
    notes: looked.filter((one) => Option.isNone(one.holds)).map((one) => lookupFailedNote(one.folder)),
  }
})

/** How many times a run tries a fresh folder's name before it gives up. */
const RUN_TRIES = 5

/**
 * A run of its own: named by when it started (`runNameOf`) and six random hexadecimal digits, its folder made only
 * when nothing is there (`ReviewLogs.fresh`), another name tried when one is taken.
 */
const freshRun = (base: string, started: number) => Effect.gen(function* () {
  const logs = yield* ReviewLogs
  const attempt = Effect.gen(function* () {
    const suffix = (yield* Random.nextIntBetween(0, 0xffffff)).toString(16).padStart(6, "0")
    const run = `${runNameOf(started)}-${suffix}`
    return { run, folder: `${base}/${run}`, made: yield* logs.fresh(`${base}/${run}`) }
  })
  return yield* attempt.pipe(Effect.retry({ times: RUN_TRIES - 1 }))
})

/** A pass or a check that could not run at all (its folder not made, a defect), as its result: `Failed`, in its failure's words, logged. */
const couldNotRun = (stage: ReviewStage) => (cause: Cause.Cause<unknown>) =>
  Effect.logWarning("a review pass could not run", cause).pipe(Effect.as<PassResult>({
    stage,
    session: Option.none(),
    ended: { _tag: "Failed", message: clipTo(Cause.prettyErrors(cause).map((error) => error.message).join("; ") || "it could not run", 300) },
    calls: [],
    opened: [],
  }))
