import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer, Option, Schema } from "effect"
import { SessionId } from "@xandreed/core"
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
import { CommitSha, PullRequest, RepoName } from "./pull-request.entity.js"
import { directoryLogs } from "./review-logs.adapter.js"
import type { PassInput } from "./review-pass.port.js"
import { ReviewPasses } from "./review-pass.port.js"
import { ReviewReport } from "./review-report.entity.js"
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
}))

const layers = Layer.mergeAll(forge, gitCheckout({ cacheRoot: fixture.cacheRoot, remoteUrl: () => fixture.remote, transports: ["file"] }), directoryLogs(logsRoot), findingsInMemory)
  .pipe(Layer.provide(hostShell({ cwd: fixture.root, env: fixture.env })))

const OPTIONS: PrepareOptions = { at: { _tag: "First" }, budgetTokens: 24_000, run: [], workflows: [], limits: DIGEST_LIMITS, timeoutMs: 60_000 }

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

describe("reviewPullRequest", () => {
  test("prepares, runs a pass, and keeps the prepared review, the report and the pass's journal folder in a run folder of its own; a rerun gets another", async () => {
    const asked: Array<PassInput> = []
    const passes = Layer.effect(ReviewPasses, Effect.gen(function* () {
      const findings = yield* Findings
      return ReviewPasses.of({
        run: (input) => Effect.gen(function* () {
          asked.push(input)
          yield* findings.record(input.reviewed.pass, { path: "src/sum.ts", line: 4, kind: "bug", severity: "low", claim: "A multiplication by one.", evidence: "total += value * 1" })
          return { pass: input.reviewed.pass, session: Option.some(SessionId.make("s-1")), ended: { _tag: "Answered" as const, summary: "One." }, calls: [{ step: 1, tokens: Option.some({ input: 10, cached: 4, output: 2 }), cost: 0.001 }], opened: ["src/sum.ts"] }
        }),
      })
    }))
    const review = () => Effect.runPromise(reviewPullRequest(repo, PULL.number, { prepare: OPTIONS, pass: { maxSteps: 4 }, model: "m" }).pipe(Effect.provide(passes.pipe(Layer.provideMerge(layers)))))
    const report = await review()
    const folder = join(logsRoot, `2-${fixture.head.slice(0, 12)}`, report.run)
    expect([asked.length, asked[0]?.journalAt, asked[0]?.options, asked[0]?.reviewed.at, asked[0]?.prompt.tail.startsWith("Review the pull request above.")]).toEqual([1, join(folder, "pass-1"), { maxSteps: 4 }, fixture.head, true])
    expect<unknown>([report.promptVersion, report.toolsVersion, report.model, report.findings.map((one) => [one.path, one.line, one.pass, one.restatesCi]), report.usage, report.passes.map((one) => one.session)]).toEqual([
      "review-prompt-2", "review-tools-2", "m", [["src/sum.ts", 4, 1, false]], { input: 10, cached: 4, output: 2, cost: 0.001 }, [Option.some("s-1")],
    ])
    expect(existsSync(join(folder, "pass-1"))).toBe(true)
    const kept = await Effect.runPromise(Schema.decodeUnknownEffect(Schema.fromJsonString(ReviewReport))(readFileSync(join(folder, "review.json"), "utf8")))
    expect(kept).toEqual(report)
    expect(readFileSync(join(folder, "prepared.json"), "utf8").includes(`"source": "first-ci-run"`)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const again = await review()
    expect([again.run === report.run, existsSync(join(folder, "review.json")), existsSync(join(logsRoot, `2-${fixture.head.slice(0, 12)}`, again.run, "review.json"))]).toEqual([false, true, true])
  })
})
