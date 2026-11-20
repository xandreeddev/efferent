import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
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
const scripted = (quote: string) => {
  const asked: Array<PassInput> = []
  const events: Array<string> = []
  const layer = Layer.effect(ReviewPasses, Effect.gen(function* () {
    const findings = yield* Findings
    return ReviewPasses.of({
      run: (input) => Effect.gen(function* () {
        asked.push(input)
        const stage = input.reviewed.stage
        if (stage._tag === "Find") {
          events.push(`pass ${stage.pass} started`)
          yield* findings.record(stage.pass, FINDING)
          if (stage.pass === 3) yield* findings.record(stage.pass, { ...FINDING, path: "README.md", line: 1 })
          if (input.onFirstAnswer !== undefined) {
            events.push(`pass ${stage.pass} answered first`)
            yield* input.onFirstAnswer
          }
        } else yield* findings.judge(stage.check, { outcome: "confirmed", reason: "It does multiply by one.", quote })
        return { stage, session: Option.some(SessionId.make("s-1")), ended: stage._tag === "Find" ? { _tag: "Answered" as const, summary: "One." } : { _tag: "Judged" as const }, calls: [{ step: 1, tokens: Option.some({ input: 10, cached: 4, output: 2 }), cost: 0.001 }], opened: ["src/sum.ts"] }
      }),
    })
  }))
  return { asked, events, layer }
}

const REVIEW_OPTIONS: ReviewOptions = {
  prepare: OPTIONS, passes: 3, pass: { maxSteps: 4 }, finder: "candidates", vote: false, verify: true, verifyConcurrency: 2, verifySteps: 6,
  budget: { total: 0.5, find: 0.3, verify: 0.2 }, model: "m",
}

const reviewWith = (passes: Layer.Layer<ReviewPasses, never, Findings>, options: ReviewOptions = REVIEW_OPTIONS) =>
  Effect.runPromise(reviewPullRequest(repo, PULL.number, options).pipe(Effect.provide(passes.pipe(Layer.provideMerge(Layer.mergeAll(layers, modelSpendMemory))))))

describe("reviewPullRequest", () => {
  test("three passes, the first alone until it answers; the findings merged; each kept bucket checked; everything kept in a run folder of its own; a rerun gets another", async () => {
    const { asked, events, layer } = scripted("total += value * 1")
    const report = await reviewWith(layer)
    const folder = join(logsRoot, "2", fixture.head, report.run)
    const finds = asked.filter((input) => input.reviewed.stage._tag === "Find")
    const checks = asked.filter((input) => input.reviewed.stage._tag === "Verify")
    expect(events.slice(0, 2)).toEqual(["pass 1 started", "pass 1 answered first"])
    expect([finds.length, finds.map((input) => input.journalAt), finds[0]?.options, finds.every((input) => input.prompt.tail.startsWith("Review the pull request above and report every plausible defect")), finds.filter((input) => input.onFirstAnswer !== undefined).length]).toEqual([
      3, [1, 2, 3].map((pass) => join(folder, `pass-${pass}`)), { maxSteps: 4 }, true, 1,
    ])
    expect([checks.length, checks[0]?.journalAt, checks[0]?.options, checks[0]?.prompt.prefix, checks[0]?.prompt.tail.startsWith("Another reviewer reported the problem below")]).toEqual([1, join(folder, "check-1"), { maxSteps: 6 }, finds[0]?.prompt.prefix, true])
    expect<unknown>([report.promptVersion, report.toolsVersion, report.findings.length, report.buckets.map((bucket) => [bucket.path, bucket.votes, bucket.why]), report.verdicts.map((check) => [check.outcome, check.quoteHolds])]).toEqual([
      "review-prompt-3", "review-tools-3", 4, [["README.md", 1, "off-changed-lines"], ["src/sum.ts", 3, "kept"]], [["confirmed", true]],
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

  test("a first pass that fails before it answers fails the review, and never leaves it waiting", async () => {
    const failing = Layer.effect(ReviewLogs, Effect.gen(function* () {
      const logs = yield* ReviewLogs
      return ReviewLogs.of({ keep: logs.keep, folder: (name) => (name.endsWith("/pass-1") ? Effect.fail(new LogsUnavailable({ name, message: "the disk is full" })) : logs.folder(name)) })
    }))
    const exit = await Effect.runPromiseExit(reviewPullRequest(repo, PULL.number, REVIEW_OPTIONS).pipe(
      Effect.provide(scripted("q").layer.pipe(Layer.provideMerge(Layer.mergeAll(failing.pipe(Layer.provideMerge(layers)), modelSpendMemory)))),
      Effect.timeout("5 seconds"),
    ))
    expect([Exit.isFailure(exit), JSON.stringify(exit).includes("the disk is full")]).toEqual([true, true])
  })

  test("with the vote on, a bucket one pass found is left out; with checks off, the kept buckets are reported unchecked", async () => {
    const { asked, layer } = scripted("total += value * 1")
    const report = await reviewWith(layer, { ...REVIEW_OPTIONS, passes: 1, vote: true, verify: false })
    expect<unknown>([asked.length, report.buckets.map((bucket) => bucket.why), report.verdicts, report.reported]).toEqual([1, ["one-vote"], [], []])
  })
})
