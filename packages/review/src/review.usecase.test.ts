import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect, Exit, Layer, Option, Schema } from "effect"
import { modelSpendMemory, SessionId } from "@xandreed/core"
import { gitCheckout } from "./checkout-git.adapter.js"
import type { CiRun } from "./forge.entity.js"
import { Forge } from "./forge.port.js"
import { findingsInMemory } from "./findings.adapter.js"
import { Findings } from "./findings.port.js"
import { gitFixture } from "./git-fixture.testing.js"
import { hostShell } from "./host-shell.adapter.js"
import { DIGEST_LIMITS } from "./log-digest.entity.js"
import type { PrepareOptions } from "./prepare-review.entity.js"
import { prepareReview } from "./prepare-review.usecase.js"
import { BranchName, CommitSha, PullRequest, RepoName } from "./pull-request.entity.js"
import { directoryLogs } from "./review-logs.adapter.js"
import { LogsUnavailable } from "./review-logs.entity.js"
import { ReviewLogs } from "./review-logs.port.js"
import type { PassInput } from "./review-pass.port.js"
import { ReviewPasses } from "./review-pass.port.js"
import { ReviewReport } from "./review-report.entity.js"
import type { ReviewOptions } from "./review.entity.js"
import { reviewPullRequest } from "./review.usecase.js"
import { reportText } from "./review-report.entity.functions.js"

const fixture = gitFixture()
afterAll(() => fixture.cleanup())
const repo = RepoName.make("owner/project")
const logsRoot = join(fixture.root, "logs")

/** Pull request #2: its head is a later commit on top of the fixture's head, which was its first. */
const PULL = Schema.decodeUnknownSync(PullRequest)({
  repo, number: 2, title: "fix the sum, then undo", body: "", author: "someone", authorIsBot: false, permission: "write",
  base: { ref: "main", sha: fixture.left }, head: { ref: "fix-sum", sha: fixture.later }, fetchRef: "refs/pull/2/head", headRepo: "owner/project", sameRepo: true,
  files: [], commits: [{ sha: fixture.head, headline: "fix the sum", authoredAt: "", committedAt: "" }, { sha: fixture.later, headline: "undo", authoredAt: "", committedAt: "" }],
})

const ciOf: Array<string> = []
const forge = Layer.succeed(Forge, Forge.of({
  pullRequest: () => Effect.succeed(PULL),
  firstHead: () => Effect.succeed({ sha: CommitSha.make(fixture.head), source: "first-ci-run" as const }),
  ciRuns: (_repo, head) => Effect.sync((): ReadonlyArray<CiRun> => {
    ciOf.push(head)
    return []
  }),
  failedLog: () => Effect.die("no run failed"),
  defaultBranch: () => Effect.succeed(BranchName.make("main")),
}))

const layers = Layer.mergeAll(forge, gitCheckout({ cacheRoot: fixture.cacheRoot, remoteUrl: () => fixture.remote, transports: ["file"] }), directoryLogs(logsRoot), findingsInMemory)
  .pipe(Layer.provide(hostShell({ cwd: fixture.root, env: fixture.env })))

const OPTIONS: PrepareOptions = { at: { _tag: "First" }, budgetTokens: 24_000, run: [], validate: false, workflows: [], limits: DIGEST_LIMITS, timeoutMs: 60_000, budgetMs: 600_000 }

describe("at the first head", () => {
  test("the commit the first run tested, its diff and rules from where its history meets the base, its own CI", async () => {
    const prepared = await Effect.runPromise(prepareReview(repo, PULL.number, OPTIONS).pipe(Effect.provide(layers)))
    expect<unknown>(prepared.at).toEqual({ sha: fixture.head, source: "first-ci-run", base: fixture.base })
    // The first head multiplied by one; the later commit undid it, so only the first head's diff changes src/sum.ts.
    expect(prepared.files.map((file) => file.path)).toContain("src/sum.ts")
    expect(prepared.rules.map((rule) => [rule.path, rule.from])).toEqual([["AGENTS.md", fixture.base], [":(glob)odd/AGENTS.md", fixture.base], ["src/AGENTS.md", fixture.base]])
    expect(ciOf.at(-1)).toBe(fixture.head)
    // What the later commit changed, kept for scoring: it undid the multiplication in src/sum.ts.
    expect<unknown>(prepared.later).toEqual(Option.some({ head: fixture.later, paths: ["src/sum.ts"] }))
    const atHead = await Effect.runPromise(prepareReview(repo, PULL.number, { ...OPTIONS, at: { _tag: "Head" } }).pipe(Effect.provide(layers)))
    expect<unknown>([atHead.at, atHead.files.map((file) => file.path).includes("src/sum.ts"), atHead.later]).toEqual([{ sha: fixture.later, source: "head", base: fixture.left }, false, Option.none()])
  })
})

const FINDING = { path: "src/sum.ts", line: 4, kind: "bug" as const, severity: "low" as const, claim: "A multiplication by one.", evidence: "total += value * 1" }

/**
 * Passes and checks by hand: each pass reports the multiplication, the third also a line no change touches; each
 * check answers `verdict`, quoting `quote`. What each was asked, and in what order the passes started and answered.
 */
const scripted = (quote: string, firstFails = false) => {
  const asked: Array<PassInput> = []
  const events: Array<string> = []
  /** What `review.json` said while the first pass ran: whether it was there, and its `complete`. */
  const during: Array<string> = []
  const layer = Layer.effect(ReviewPasses, Effect.gen(function* () {
    const findings = yield* Findings
    return ReviewPasses.of({
      run: (input) => Effect.gen(function* () {
        asked.push(input)
        const stage = input.reviewed.stage
        if (stage._tag === "Find") {
          events.push(`pass ${stage.pass} started`)
          const record = join(dirname(input.journalAt), "review.json")
          if (stage.pass === 1) during.push(existsSync(record) ? `complete ${JSON.parse(readFileSync(record, "utf8")).complete}` : "none")
          if (firstFails) {
            if (input.onFirstAnswer !== undefined) yield* input.onFirstAnswer(false)
            return { stage, session: Option.none(), ended: { _tag: "ModelFailed" as const, message: "the key is wrong" }, calls: [{ step: 1, tokens: Option.none(), cost: 0 }], opened: [] }
          }
          yield* findings.record(input.reviewed.run, stage.pass, FINDING)
          if (stage.pass === 3) yield* findings.record(input.reviewed.run, stage.pass, { ...FINDING, path: "README.md", line: 1 })
          if (input.onFirstAnswer !== undefined) {
            events.push(`pass ${stage.pass} answered first`)
            yield* input.onFirstAnswer(true)
          }
        } else yield* findings.judge(input.reviewed.run, stage.check, { outcome: "confirmed", reason: "It does multiply by one.", quote })
        return { stage, session: Option.some(SessionId.make("s-1")), ended: stage._tag === "Find" ? { _tag: "Answered" as const, summary: "One." } : { _tag: "Judged" as const }, calls: [{ step: 1, tokens: Option.some({ input: 10, cached: 4, output: 2 }), cost: 0.001 }], opened: ["src/sum.ts"] }
      }),
    })
  }))
  return { asked, events, during, layer }
}

const REVIEW_OPTIONS: ReviewOptions = {
  prepare: OPTIONS, passes: 3, pass: { maxSteps: 4, reserve: 0.1 }, finder: "candidates", vote: false, verify: true, verifyConcurrency: 2, verifySteps: 6,
  budget: { total: 0.5, find: 0.3, verify: 0.2 }, model: "m",
}

const reviewWith = (passes: Layer.Layer<ReviewPasses, never, Findings>, options: ReviewOptions = REVIEW_OPTIONS) =>
  Effect.runPromise(reviewPullRequest(repo, PULL.number, options).pipe(Effect.provide(passes.pipe(Layer.provideMerge(Layer.mergeAll(layers, modelSpendMemory))))))

describe("reviewPullRequest", () => {
  test("three passes, the first alone until it answers; the findings merged; each kept bucket checked; everything kept in a run folder of its own; a rerun gets another", async () => {
    const { asked, events, during, layer } = scripted("total += value * 1")
    const report = await reviewWith(layer)
    const folder = join(logsRoot, "2", fixture.head, report.run)
    const finds = asked.filter((input) => input.reviewed.stage._tag === "Find")
    const checks = asked.filter((input) => input.reviewed.stage._tag === "Verify")
    expect([events.slice(0, 2), during, /-[0-9a-f]{6}$/.test(report.run), report.complete]).toEqual([["pass 1 started", "pass 1 answered first"], ["complete false"], true, true])
    // Each pass keeps back at most half the find stage split among the passes: $0.30 / 6.
    expect([finds.length, finds.map((input) => input.journalAt), finds[0]?.options, finds.every((input) => input.prompt.tail.startsWith("Review the pull request above and report every plausible defect")), finds.filter((input) => input.onFirstAnswer !== undefined).length]).toEqual([
      3, [1, 2, 3].map((pass) => join(folder, `pass-${pass}`)), { maxSteps: 4, reserve: 0.3 / (2 * 3) }, true, 1,
    ])
    expect([checks.length, checks[0]?.journalAt, checks[0]?.options, checks[0]?.prompt.prefix, checks[0]?.prompt.tail.startsWith("Another reviewer reported the problem below")]).toEqual([1, join(folder, "check-1"), { maxSteps: 6, reserve: 0 }, finds[0]?.prompt.prefix, true])
    expect<unknown>([report.promptVersion, report.toolsVersion, report.findings.length, report.buckets.map((bucket) => [bucket.path, bucket.votes, bucket.why]), report.verdicts.map((check) => [check.outcome, check.quoteHolds])]).toEqual([
      "review-prompt-4", "review-tools-4", 4, [["README.md", 1, "off-changed-lines"], ["src/sum.ts", 3, "kept"]], [["confirmed", true]],
    ])
    expect<unknown>([report.reported.map((one) => [one.path, one.line, one.votes, one.checked]), report.stages.find, report.stages.verify.calls]).toEqual([
      [["src/sum.ts", 4, 3, "It does multiply by one."]], { input: 30, cached: 12, output: 6, cost: 0.003, calls: 3 }, 1,
    ])
    expect([existsSync(join(folder, "pass-1")), existsSync(join(folder, "check-1"))]).toEqual([true, true])
    const kept = await Effect.runPromise(Schema.decodeUnknownEffect(Schema.fromJsonString(ReviewReport))(readFileSync(join(folder, "review.json"), "utf8")))
    expect(kept).toEqual(report)
    expect(readFileSync(join(folder, "prepared.json"), "utf8").includes(`"source": "first-ci-run"`)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const again = await reviewWith(scripted("total += value * 1").layer)
    expect([again.run === report.run, existsSync(join(folder, "review.json")), existsSync(join(logsRoot, "2", fixture.head, again.run, "review.json"))]).toEqual([false, true, true])
  })

  test("a confirmed verdict whose quote is not in the file near the cited lines counts as unsure, and is not reported", async () => {
    const report = await reviewWith(scripted("return total * 2").layer)
    expect<unknown>([report.verdicts.map((check) => [check.outcome, check.quoteHolds, check.why]), report.reported]).toEqual([[["unsure", false, "its quote is not in the file near the cited lines"]], []])
  })

  test("a first pass that cannot run starts no other, never leaves the review waiting, and the review keeps its record of it", async () => {
    const failing = Layer.effect(ReviewLogs, Effect.gen(function* () {
      const logs = yield* ReviewLogs
      return ReviewLogs.of({ ...logs, folder: (name) => (name.endsWith("/pass-1") ? Effect.fail(new LogsUnavailable({ name, message: "the disk is full" })) : logs.folder(name)) })
    }))
    const { asked, layer } = scripted("q")
    const exit = await Effect.runPromiseExit(reviewPullRequest(repo, PULL.number, REVIEW_OPTIONS).pipe(
      Effect.provide(layer.pipe(Layer.provideMerge(Layer.mergeAll(failing.pipe(Layer.provideMerge(layers)), modelSpendMemory)))),
      Effect.timeout("5 seconds"),
    ))
    const report = Exit.isSuccess(exit) ? exit.value : undefined
    const kept = report === undefined ? "" : readFileSync(join(logsRoot, "2", fixture.head, report.run, "review.json"), "utf8")
    expect<unknown>([asked.length, report?.passes.map((pass) => pass.ended), report?.complete, kept.includes("the disk is full"), report === undefined ? "" : reportText(report).split("\n")[2]]).toEqual([
      0, [{ _tag: "Failed", message: "the disk is full" }], true, true, "Incomplete: no pass finished.",
    ])
  })

  test("a first pass whose first call fails starts no other", async () => {
    const { asked, layer } = scripted("q", true)
    const report = await reviewWith(layer)
    expect<unknown>([asked.length, report.passes.map((pass) => pass.ended._tag)]).toEqual([1, ["ModelFailed"]])
  })

  test("a layer reused across reviews never hands one run another's findings", async () => {
    const { layer } = scripted("total += value * 1")
    const [one, two] = await Effect.runPromise(Effect.all([reviewPullRequest(repo, PULL.number, REVIEW_OPTIONS), reviewPullRequest(repo, PULL.number, REVIEW_OPTIONS)], { concurrency: 1 }).pipe(
      Effect.provide(layer.pipe(Layer.provideMerge(Layer.mergeAll(layers, modelSpendMemory)))),
    ))
    expect([one.run === two.run, one.findings.length, two.findings.length, two.verdicts.length]).toEqual([false, 4, 4, 1])
  })

  test("with the vote on, a bucket one pass found is left out; with checks off, the kept buckets are reported unchecked", async () => {
    const { asked, layer } = scripted("total += value * 1")
    const report = await reviewWith(layer, { ...REVIEW_OPTIONS, passes: 1, vote: true, verify: false })
    expect<unknown>([asked.length, report.buckets.map((bucket) => bucket.why), report.verdicts, report.reported]).toEqual([1, ["one-vote"], [], []])
  })
})
