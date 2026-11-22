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
import type { HostToolsOffered, TurnInput } from "./review-turn.port.js"
import { ReviewTurns } from "./review-turn.port.js"
import { ReviewReport } from "./review-report.entity.js"
import { DEFAULT_GROUP_OPTIONS } from "./review.entity.js"
import type { ReviewOptions } from "./review.entity.js"
import { DEFAULT_GROUP_RESERVE, DEFAULT_GROUP_STEPS, NO_GROUP_NOTE, NOT_REVIEWED_BECAUSE } from "./file-group.entity.js"
import { firstCallHold, lookupFailedNote, uncachedCheckNote } from "./file-group.entity.functions.js"
import { CommitMissing } from "./checkout.entity.js"
import { Checkout } from "./checkout.port.js"
import { STOCK_POLICIES } from "./prepare-review.usecase.functions.js"
import type { TurnLimits, TurnResult } from "./review-turn.entity.js"
import { FOCUS_TAIL } from "./review-prompt.entity.js"
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
const historyOf: Array<string> = []
const forge =Layer.succeed(Forge, Forge.of({
  pullRequest: () => Effect.succeed(PULL),
  firstHead: () => Effect.succeed({ sha: CommitSha.make(fixture.head), source: "first-ci-run" as const }),
  // Opened with one description, edited after the first head was committed to list the fix.
  descriptionHistory: (_repo, _pull, at) => Effect.sync(() => {
    historyOf.push(at)
    return {
      committedAt: "2026-11-01T10:00:00Z",
      edits: [
        { editedAt: "2026-11-02T08:00:00Z", text: Option.some("Fix the sum.\n\nReview follow-up: the multiplication by one is undone.") },
        { editedAt: "2026-11-01T09:00:00Z", text: Option.some("Fix the sum.") },
      ],
      total: 2,
    }
  }),
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
  test("the commit the first run tested, its diff and rules from where its history meets the base, its own CI, its description as it stood then", async () => {
    const prepared = await Effect.runPromise(prepareReview(repo, PULL.number, OPTIONS).pipe(Effect.provide(layers)))
    expect<unknown>(prepared.at).toEqual({ sha: fixture.head, source: "first-ci-run", base: fixture.base })
    // The first head multiplied by one; the later commit undid it, so only the first head's diff changes src/sum.ts.
    expect(prepared.files.map((file) => file.path)).toContain("src/sum.ts")
    expect(prepared.rules.map((rule) => [rule.path, rule.from])).toEqual([["AGENTS.md", fixture.base], [":(glob)odd/AGENTS.md", fixture.base], ["src/AGENTS.md", fixture.base]])
    expect(ciOf.at(-1)).toBe(fixture.head)
    // What the later commit changed, kept for scoring: it undid the multiplication in src/sum.ts.
    expect<unknown>(prepared.later).toEqual(Option.some({ head: fixture.later, paths: ["src/sum.ts"] }))
    // The description as it stood when the first head was committed, not the later one that lists the fix.
    expect([prepared.pullRequest.body, historyOf.at(-1)]).toEqual(["Fix the sum.", fixture.head])
    const asked = historyOf.length
    const atHead = await Effect.runPromise(prepareReview(repo, PULL.number, { ...OPTIONS, at: { _tag: "Head" } }).pipe(Effect.provide(layers)))
    expect<unknown>([atHead.at, atHead.files.map((file) => file.path).includes("src/sum.ts"), atHead.later]).toEqual([{ sha: fixture.later, source: "head", base: fixture.left }, false, Option.none()])
    // The head is reviewed with the current description: no history asked.
    expect([atHead.pullRequest.body, historyOf.length]).toEqual(["", asked])
  })
})

const FINDING = { path: "src/sum.ts", line: 4, kind: "bug" as const, severity: "low" as const, claim: "A multiplication by one.", evidence: "total += value * 1" }

/** Turns that offer the six tools alone. */
const NO_HOST_TOOLS: HostToolsOffered = { names: [], declarationBytes: 0 }

/** What the scripted turns say they were given beyond the model, which `review.json` keeps. */
const LIMITS: TurnLimits = { replayThinking: true, readTokens: Option.some(88_000) }

/**
 * Turns and checks by hand: each turn reports the multiplication, the third also a line no change touches; each
 * check answers `verdict`, quoting `quote`. What each was asked, and in what order the turns started and answered.
 */
const scripted = (quote: string, firstFails = false, extra?: typeof FINDING, hostTools: HostToolsOffered = NO_HOST_TOOLS) => {
  const asked: Array<TurnInput> = []
  const events: Array<string> = []
  /** What `review.json` said while the first turn ran: whether it was there, and its `complete`. */
  const during: Array<string> = []
  const layer = Layer.effect(ReviewTurns, Effect.gen(function* () {
    const findings = yield* Findings
    return ReviewTurns.of({
      run: (input) => Effect.gen(function* () {
        asked.push(input)
        const stage = input.reviewed.stage
        if (stage._tag === "Find") {
          events.push(`turn ${stage.turn} started`)
          const record = join(dirname(input.journalAt), "review.json")
          if (stage.turn === 1) during.push(existsSync(record) ? `complete ${JSON.parse(readFileSync(record, "utf8")).complete}` : "none")
          if (firstFails) {
            if (input.onFirstAnswer !== undefined) yield* input.onFirstAnswer(false)
            return { stage, session: Option.none(), ended: { _tag: "ModelFailed" as const, message: "the key is wrong" }, calls: [{ step: 1, tokens: Option.none(), cost: 0 }], opened: [] }
          }
          yield* findings.record(input.reviewed.run, stage.turn, FINDING)
          if (stage.turn === 3) yield* findings.record(input.reviewed.run, stage.turn, { ...FINDING, path: "README.md", line: 1 })
          if (stage.turn === 1 && extra !== undefined) yield* findings.record(input.reviewed.run, stage.turn, extra)
          if (input.onFirstAnswer !== undefined) {
            events.push(`turn ${stage.turn} answered first`)
            yield* input.onFirstAnswer(true)
          }
        } else yield* findings.judge(input.reviewed.run, stage.check, { outcome: "confirmed", reason: "It does multiply by one.", quote })
        return { stage, session: Option.some(SessionId.make("s-1")), ended: stage._tag === "Find" ? { _tag: "Answered" as const, summary: "One." } : { _tag: "Judged" as const }, calls: [{ step: 1, tokens: Option.some({ input: 10, cached: 4, output: 2 }), cost: 0.001 }], opened: ["src/sum.ts"] }
      }),
      hostTools,
      limits: LIMITS,
    })
  }))
  return { asked, events, during, layer }
}

const REVIEW_OPTIONS: ReviewOptions = {
  prepare: OPTIONS, focus: "whole", turns: 3, turn: { maxSteps: 4, reserve: 0.1 }, groups: DEFAULT_GROUP_OPTIONS, finder: "candidates", vote: false, verify: true, verifyConcurrency: 2, verifySteps: 6,
  budget: { total: 0.5, find: 0.3, verify: 0.2 }, effort: { find: "default", check: "default" }, model: "m",
  price: { input: 0.3, output: 1.2, maxOutputTokens: 4_096, bytesPerToken: 1 },
}

/** One file a group, so the fixture's pull request makes several. */
const ONE_A_GROUP = { ...DEFAULT_GROUP_OPTIONS, bounds: { tokens: 6_000, files: 1 }, order: "git" as const }

/** Turns that charge `cost` to their stage per turn and end as `ended` with `calls`, counting how many started. */
const charging = (cost: number, ended: TurnResult["ended"], answered: boolean, hostTools: HostToolsOffered = NO_HOST_TOOLS) => {
  const started: Array<number> = []
  const layer = Layer.succeed(ReviewTurns, ReviewTurns.of({
    run: (input) => Effect.gen(function* () {
      started.push(started.length + 1)
      if (cost > 0) {
        const hold = yield* Effect.orDie(input.spend.reserve({ amount: cost, caps: {} }))
        yield* Effect.orDie(input.spend.settle(hold, cost))
      }
      return { stage: input.reviewed.stage, session: Option.none(), ended, calls: [{ step: 1, tokens: answered ? Option.some({ input: 10, cached: 0, output: 2 }) : Option.none(), cost }], opened: [] }
    }),
    hostTools,
    limits: LIMITS,
  }))
  return { started, layer }
}

const reviewWith = (turns: Layer.Layer<ReviewTurns, never, Findings>, options: ReviewOptions = REVIEW_OPTIONS) =>
  Effect.runPromise(reviewPullRequest(repo, PULL.number, options).pipe(Effect.provide(turns.pipe(Layer.provideMerge(Layer.mergeAll(layers, modelSpendMemory))))))

describe("reviewPullRequest", () => {
  test("three turns, the first alone until it answers; the findings merged; each kept bucket checked; everything kept in a run folder of its own; a rerun gets another", async () => {
    const { asked, events, during, layer } = scripted("total += value * 1")
    const report = await reviewWith(layer)
    const folder = join(logsRoot, "2", fixture.head, report.run)
    const finds = asked.filter((input) => input.reviewed.stage._tag === "Find")
    const checks = asked.filter((input) => input.reviewed.stage._tag === "Verify")
    expect([events.slice(0, 2), during, /-[0-9a-f]{6}$/.test(report.run), report.complete]).toEqual([["turn 1 started", "turn 1 answered first"], ["complete false"], true, true])
    // Turns beside each other keep nothing back for a closing call.
    expect([finds.length, finds.map((input) => input.journalAt), finds[0]?.options, finds.every((input) => input.prompt.tail.startsWith("Review the pull request above and report every plausible defect")), finds.filter((input) => input.onFirstAnswer !== undefined).length]).toEqual([
      3, [1, 2, 3].map((turn) => join(folder, `turn-${turn}`)), { maxSteps: 4, reserve: 0 }, true, 1,
    ])
    // The one check runs alone, so it keeps back its closing call's reserve.
    expect([checks.length, checks[0]?.journalAt, checks[0]?.options, checks[0]?.prompt.prefix, checks[0]?.prompt.tail.startsWith("Another reviewer reported the problem below")]).toEqual([1, join(folder, "check-1"), { maxSteps: 6, reserve: 0.1 }, finds[0]?.prompt.prefix, true])
    expect<unknown>([report.promptVersion, report.toolsVersion, report.hostTools, report.findings.length, report.buckets.map((bucket) => [bucket.path, bucket.votes, bucket.why]), report.verdicts.map((check) => [check.outcome, check.quoteHolds])]).toEqual([
      "review-prompt-10", "review-tools-6", [], 4, [["README.md", 1, "off-changed-lines"], ["src/sum.ts", 3, "kept"]], [["confirmed", true]],
    ])
    expect<unknown>([report.reported.map((one) => [one.path, one.line, one.votes, one.checked]), report.stages.find, report.stages.verify.calls]).toEqual([
      [["src/sum.ts", 4, 3, "It does multiply by one."]], { input: 30, cached: 12, output: 6, cost: 0.003, calls: 3 }, 1,
    ])
    expect([existsSync(join(folder, "turn-1")), existsSync(join(folder, "check-1"))]).toEqual([true, true])
    const kept = await Effect.runPromise(Schema.decodeUnknownEffect(Schema.fromJsonString(ReviewReport))(readFileSync(join(folder, "review.json"), "utf8")))
    expect(kept).toEqual(report)
    // What the turns were given beyond the model is kept, the read limit as a number on the wire.
    expect<unknown>([report.limits, JSON.parse(readFileSync(join(folder, "review.json"), "utf8")).limits]).toEqual([LIMITS, { replayThinking: true, readTokens: 88_000 }])
    expect(readFileSync(join(folder, "prepared.json"), "utf8").includes(`"source": "first-ci-run"`)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const again = await reviewWith(scripted("total += value * 1").layer)
    expect([again.run === report.run, existsSync(join(folder, "review.json")), existsSync(join(logsRoot, "2", fixture.head, again.run, "review.json"))]).toEqual([false, true, true])
  })

  test("a bucket's best refuted, its second finding checked in the next round, confirmed and reported in its own words", async () => {
    const asked: Array<TurnInput> = []
    const layer = Layer.effect(ReviewTurns, Effect.gen(function* () {
      const findings = yield* Findings
      return ReviewTurns.of({
        run: (input) => Effect.gen(function* () {
          asked.push(input)
          const stage = input.reviewed.stage
          if (stage._tag === "Find") {
            // Two mechanisms on one line: turn 1's medium one is the bucket's best, turn 2's low one its second.
            yield* findings.record(input.reviewed.run, stage.turn, stage.turn === 1 ? { ...FINDING, severity: "medium", claim: "Claim A." } : { ...FINDING, claim: "Claim B." })
            if (input.onFirstAnswer !== undefined) yield* input.onFirstAnswer(true)
          } else yield* findings.judge(input.reviewed.run, stage.check, stage.check === 1
            ? { outcome: "refuted", reason: "Not A.", quote: "total += value * 1" }
            : { outcome: "confirmed", reason: "B holds.", quote: "total += value * 1" })
          return { stage, session: Option.none(), ended: stage._tag === "Find" ? { _tag: "Answered" as const, summary: "One." } : { _tag: "Judged" as const }, calls: [], opened: [] }
        }),
        hostTools: NO_HOST_TOOLS,
        limits: LIMITS,
      })
    }))
    const report = await reviewWith(layer, { ...REVIEW_OPTIONS, turns: 2 })
    const checks = asked.filter((input) => input.reviewed.stage._tag === "Verify")
    expect<unknown>([
      checks.map((input) => input.prompt.tail.includes("Claim A.") ? "A" : input.prompt.tail.includes("Claim B.") ? "B" : "?"),
      report.verdicts.map((check) => [check.check, check.finding.turn, check.outcome, check.quoteHolds]),
      report.reported.map((one) => [one.turn, one.claim, one.severity, one.votes, one.checked]),
    ]).toEqual([["A", "B"], [[1, 1, "refuted", true], [2, 2, "confirmed", true]], [[2, "Claim B.", "low", 2, "B holds."]]])
  })

  test("a confirmed verdict whose quote is not in the file near the cited lines counts as unsure, and is not reported", async () => {
    const report = await reviewWith(scripted("return total * 2").layer)
    // The bucket holds the three turns' findings: none confirmed, so each is checked in a round of its own.
    const unsure = ["unsure", false, "its quote is not in the file near the cited lines"]
    expect<unknown>([report.verdicts.map((check) => [check.finding.turn, check.outcome, check.quoteHolds, check.why]), report.reported]).toEqual([[[1, ...unsure], [2, ...unsure], [3, ...unsure]], []])
  })

  test("a first turn that cannot run starts no other, never leaves the review waiting, and the review keeps its record of it", async () => {
    const failing = Layer.effect(ReviewLogs, Effect.gen(function* () {
      const logs = yield* ReviewLogs
      return ReviewLogs.of({ ...logs, folder: (name) => (name.endsWith("/turn-1") ? Effect.fail(new LogsUnavailable({ name, message: "the disk is full" })) : logs.folder(name)) })
    }))
    const { asked, layer } = scripted("q")
    const exit = await Effect.runPromiseExit(reviewPullRequest(repo, PULL.number, REVIEW_OPTIONS).pipe(
      Effect.provide(layer.pipe(Layer.provideMerge(Layer.mergeAll(failing.pipe(Layer.provideMerge(layers)), modelSpendMemory)))),
      Effect.timeout("5 seconds"),
    ))
    const report = Exit.isSuccess(exit) ? exit.value : undefined
    const kept = report === undefined ? "" : readFileSync(join(logsRoot, "2", fixture.head, report.run, "review.json"), "utf8")
    expect<unknown>([asked.length, report?.turns.map((turn) => turn.ended), report?.complete, kept.includes("the disk is full"), report === undefined ? "" : reportText(report).split("\n")[2]]).toEqual([
      0, [{ _tag: "Failed", message: "the disk is full" }], true, true, "Incomplete: no turn finished.",
    ])
  })

  test("a first turn whose first call fails starts no other, and the report says the find stage stopped", async () => {
    const { asked, layer } = scripted("q", true)
    const report = await reviewWith(layer)
    expect<unknown>([asked.length, report.turns.map((turn) => turn.ended._tag), report.turnsAsked, reportText(report).split("\n").filter((line) => line.includes("did not start"))]).toEqual([
      1, ["ModelFailed"], 3, ["Turns 2 to 3 did not start: the find stage stopped because turn 1 ended before its first call answered."],
    ])
  })

  test("a layer reused across reviews never hands one run another's findings", async () => {
    const { layer } = scripted("total += value * 1")
    const [one, two] = await Effect.runPromise(Effect.all([reviewPullRequest(repo, PULL.number, REVIEW_OPTIONS), reviewPullRequest(repo, PULL.number, REVIEW_OPTIONS)], { concurrency: 1 }).pipe(
      Effect.provide(layer.pipe(Layer.provideMerge(Layer.mergeAll(layers, modelSpendMemory)))),
    ))
    expect([one.run === two.run, one.findings.length, two.findings.length, two.verdicts.length]).toEqual([false, 4, 4, 1])
  })

  test("focused: one turn a group, one after another, each with its group's prefix and its finder's words; the check starts with the prefix of the group holding its finding's file; the groups recorded", async () => {
    const { asked, events, layer } = scripted("total += value * 1")
    const report = await reviewWith(layer, { ...REVIEW_OPTIONS, focus: "groups" })
    const finds = asked.filter((input) => input.reviewed.stage._tag === "Find")
    const checks = asked.filter((input) => input.reviewed.stage._tag === "Verify")
    const sumGroup = report.groups.find((run) => run.group.paths.includes("src/sum.ts"))
    const sumTurn = Option.getOrElse(sumGroup?.turn ?? Option.none(), () => 0)
    expect<unknown>([
      report.focus,
      report.groups.map((run) => [run.group.number, run.group.package, Option.isSome(run.turn), run.notReviewed]),
      finds.length,
      events.filter((event) => event.endsWith("started")).length,
      finds.every((input) => input.prompt.tail === FOCUS_TAIL.candidates && input.prompt.prefix.length === 3 && input.onFirstAnswer === undefined),
      finds[0]?.options,
      report.turnsAsked,
    ]).toEqual(["groups", report.groups.map((run, index) => [index + 1, ".", true, ""]), report.groups.length, report.groups.length, true, { maxSteps: DEFAULT_GROUP_STEPS, reserve: DEFAULT_GROUP_RESERVE }, report.groups.length])
    // The turn's first three messages are the check's, byte for byte.
    expect([checks.length, checks[0]?.prompt.prefix === finds[sumTurn - 1]?.prompt.prefix, JSON.stringify(checks[0]?.prompt.prefix) === JSON.stringify(finds[sumTurn - 1]?.prompt.prefix)]).toEqual([1, true, true])
    expect(finds[sumTurn - 1]?.prompt.prefix[2]?.content.includes("File: src/sum.ts")).toBe(true)
  })

  test("focused, several groups: the second message the same in every group's prefix, the third each group's own; the check on the prefix of the group holding its finding's file", async () => {
    const { asked, layer } = scripted("total += value * 1")
    const report = await reviewWith(layer, { ...REVIEW_OPTIONS, focus: "groups", groups: { ...DEFAULT_GROUP_OPTIONS, bounds: { tokens: 6_000, files: 1 } } })
    const finds = asked.filter((input) => input.reviewed.stage._tag === "Find")
    const checks = asked.filter((input) => input.reviewed.stage._tag === "Verify")
    const holding = report.groups.findIndex((run) => run.group.paths.includes("src/sum.ts"))
    expect([
      finds.length > 1,
      finds.every((input) => input.prompt.prefix[1]?.content === finds[0]?.prompt.prefix[1]?.content),
      new Set(finds.map((input) => input.prompt.prefix[2]?.content)).size,
      holding > 0,
      checks.length,
      checks[0]?.prompt.prefix === finds[holding]?.prompt.prefix,
    ]).toEqual([true, true, finds.length, true, 1, true])
  })

  test("focused: a group starts only with its closing reserve and its first call's hold, sized from its prompt, left in the find stage", async () => {
    const sized = scripted("q")
    await reviewWith(sized.layer, { ...REVIEW_OPTIONS, focus: "groups", verify: false })
    const hold = firstCallHold(sized.asked[0]!.prompt, REVIEW_OPTIONS.price)
    // Under $0.10 the reserve is half the stage, so the turn starts once the stage is twice the first call's hold.
    const run = async (find: number) => (await reviewWith(scripted("q").layer, { ...REVIEW_OPTIONS, focus: "groups", verify: false, budget: { total: 0.5, find, verify: 0.2 } })).groups.map((one) => [Option.isSome(one.turn), one.notReviewed])
    expect([hold > 0.004 && hold < 0.02, await run(2 * hold - 0.0005), await run(2 * hold + 0.0005)]).toEqual([true, [[false, NOT_REVIEWED_BECAUSE.spent]], [[true, ""]]])
  })

  test("review.json names the tools a host added, in the order offered, beside the six's unchanged version", async () => {
    const hostTools = { names: ["findDefinition", "findReferences"], declarationBytes: 0 }
    const report = await reviewWith(scripted("total += value * 1", false, undefined, hostTools).layer)
    const kept = await Effect.runPromise(Schema.decodeUnknownEffect(Schema.fromJsonString(ReviewReport))(readFileSync(join(logsRoot, "2", fixture.head, report.run, "review.json"), "utf8")))
    expect<unknown>([report.toolsVersion, report.hostTools, kept.hostTools]).toEqual(["review-tools-6", ["findDefinition", "findReferences"], ["findDefinition", "findReferences"]])
  })

  test("focused: a host's tool declarations count in a group's first call's hold; none counts nothing", async () => {
    const sized = scripted("q")
    await reviewWith(sized.layer, { ...REVIEW_OPTIONS, focus: "groups", verify: false })
    const prompt = sized.asked[0]!.prompt
    const declarationBytes = 20_000
    const hold = firstCallHold(prompt, REVIEW_OPTIONS.price, declarationBytes)
    const run = async (find: number) => (await reviewWith(scripted("q", false, undefined, { names: ["findDefinition"], declarationBytes }).layer, { ...REVIEW_OPTIONS, focus: "groups", verify: false, budget: { total: 0.5, find, verify: 0.2 } })).groups.map((one) => [Option.isSome(one.turn), one.notReviewed])
    // A stage that fits the six's hold but not the host's declarations too does not start the group.
    expect([firstCallHold(prompt, REVIEW_OPTIONS.price, 0) === firstCallHold(prompt, REVIEW_OPTIONS.price), hold > firstCallHold(prompt, REVIEW_OPTIONS.price), await run(2 * hold - 0.0005), await run(2 * hold + 0.0005)]).toEqual([true, true, [[false, NOT_REVIEWED_BECAUSE.spent]], [[true, ""]]])
  })

  test("focused, on a budget: turns that settle $0.03 each run groups 1 to 3 under $0.15, and the rest are listed as not reviewed", async () => {
    const { started, layer } = charging(0.03, { _tag: "Answered", summary: "" }, true)
    // Input free, so every first call holds its output alone (4,096 tokens at $1.20 a million, about $0.005) whatever its group's size.
    const report = await reviewWith(layer, { ...REVIEW_OPTIONS, focus: "groups", verify: false, groups: ONE_A_GROUP, budget: { total: 0.5, find: 0.15, verify: 0.2 }, price: { ...REVIEW_OPTIONS.price, input: 0 } })
    // The reserve is $0.10, at most half the $0.15 stage: $0.075. Rooms of $0.15, $0.12 and $0.09 fit it and the first
    // call ($0.08), $0.06 does not.
    expect<unknown>([report.groups.length >= 5, started.length, report.groups.map((run) => [Option.isSome(run.turn), run.notReviewed]), report.stages.find.cost]).toEqual([
      true, 3, report.groups.map((_, index) => (index < 3 ? [true, ""] : [false, NOT_REVIEWED_BECAUSE.spent])), 0.09,
    ])
  })

  test("focused: a turn the stage refused before any call answered reviewed nothing, and stops the groups after it; each group's turn retries its first call", async () => {
    const { started, layer } = charging(0, { _tag: "SpendRefused", message: "the stage's cap refused the first call" }, false)
    const report = await reviewWith(layer, { ...REVIEW_OPTIONS, focus: "groups", verify: false, groups: ONE_A_GROUP })
    expect<unknown>([started.length, report.groups.map((run) => [Option.isSome(run.turn), run.notReviewed])]).toEqual([
      1, report.groups.map((_, index) => (index === 0 ? [true, `${NOT_REVIEWED_BECAUSE.noCall}: the stage's cap refused the first call`] : [false, NOT_REVIEWED_BECAUSE.stopped])),
    ])
    const { asked, layer: told } = scripted("q")
    await reviewWith(told, { ...REVIEW_OPTIONS, focus: "groups", verify: false })
    expect(asked.every((input) => input.retryFirstCall === true && input.onFirstAnswer === undefined)).toBe(true)
  })

  test("focused: a turn that failed otherwise before any call answered (a provider's error twice) loses its group alone; the next group runs", async () => {
    const { started, layer } = charging(0, { _tag: "ModelFailed", message: "the provider is overloaded" }, false)
    const report = await reviewWith(layer, { ...REVIEW_OPTIONS, focus: "groups", verify: false, groups: ONE_A_GROUP })
    expect<unknown>([report.groups.length > 1, started.length, report.groups.map((run) => [Option.isSome(run.turn), run.notReviewed])]).toEqual([
      true, report.groups.length, report.groups.map(() => [true, `${NOT_REVIEWED_BECAUSE.noCall}: the provider is overloaded`]),
    ])
  })

  test("focused: a turn the stage refused after a call answered does not stop the next group's", async () => {
    const { started, layer } = charging(0, { _tag: "SpendRefused", message: "its reserve crowded the call out" }, true)
    const report = await reviewWith(layer, { ...REVIEW_OPTIONS, focus: "groups", verify: false, groups: ONE_A_GROUP })
    expect([report.groups.length > 1, started.length, report.groups.every((run) => Option.isSome(run.turn) && run.notReviewed === "")]).toEqual([true, report.groups.length, true])
  })

  test("focused: the files no group holds are listed with why; a package.json that cannot be looked up is noted, never taken for none silently", async () => {
    const failing = Layer.effect(Checkout, Effect.gen(function* () {
      const checkout = yield* Checkout
      return Checkout.of({ ...checkout, entry: (repo, at, path) => (path.endsWith("package.json") ? Effect.fail(new CommitMissing({ sha: at, message: "the clone is gone" })) : checkout.entry(repo, at, path)) })
    }))
    const report = await Effect.runPromise(reviewPullRequest(repo, PULL.number, { ...REVIEW_OPTIONS, focus: "groups", verify: false }).pipe(
      Effect.provide(scripted("q").layer.pipe(Layer.provideMerge(Layer.mergeAll(failing.pipe(Layer.provideMerge(layers)), modelSpendMemory)))),
    ))
    expect<unknown>([report.ungrouped, report.notes.includes(lookupFailedNote("")), report.notes.includes(lookupFailedNote("src")), report.notes.every((note) => note.startsWith("The package.json of "))]).toEqual([
      [{ path: "docs/old.md", why: "docs" }, { path: "src/AGENTS.md", why: "docs" }], true, true, true,
    ])
    // The control: with the lookups answered, no note.
    expect((await reviewWith(scripted("q").layer, { ...REVIEW_OPTIONS, focus: "groups", verify: false })).notes).toEqual([])
  })

  test("focused: a check of a finding in a file no group holds runs on the prefix of the group whose turn reported it", async () => {
    const { asked, layer } = scripted("total += value * 1", false, { ...FINDING, path: "src/AGENTS.md", line: 1, evidence: "Source rules the pull request rewrote." })
    const report = await reviewWith(layer, { ...REVIEW_OPTIONS, focus: "groups", groups: ONE_A_GROUP })
    const finds = asked.filter((input) => input.reviewed.stage._tag === "Find")
    const checkOfOther = asked.find((input) => input.reviewed.stage._tag === "Verify" && input.prompt.tail.includes("File: src/AGENTS.md"))
    expect([report.ungrouped.some((file) => file.path === "src/AGENTS.md"), checkOfOther?.prompt.prefix === finds[0]?.prompt.prefix]).toEqual([true, true])
  })

  test("focused: a check on the prefix of a group whose turn never answered is noted, since it has no cache to read", async () => {
    const layer = Layer.effect(ReviewTurns, Effect.gen(function* () {
      const findings = yield* Findings
      return ReviewTurns.of({
        run: (input) => Effect.gen(function* () {
          const stage = input.reviewed.stage
          if (stage._tag === "Find") yield* findings.record(input.reviewed.run, stage.turn, FINDING)
          else yield* findings.judge(input.reviewed.run, stage.check, { outcome: "refuted", reason: "r", quote: "q" })
          return { stage, session: Option.none(), ended: { _tag: "ModelFailed" as const, message: "no answer" }, calls: [{ step: 1, tokens: Option.none(), cost: 0 }], opened: [] }
        }),
        hostTools: NO_HOST_TOOLS,
        limits: LIMITS,
      })
    }))
    const report = await reviewWith(layer, { ...REVIEW_OPTIONS, focus: "groups" })
    expect<unknown>([report.groups.map((run) => run.notReviewed), report.verdicts.length, report.notes]).toEqual([[`${NOT_REVIEWED_BECAUSE.noCall}: no answer`], 1, [uncachedCheckNote(1, 1)]])
  })

  test("focused, with no file to group: the review falls back to the whole focus and says so", async () => {
    const onlyDocs = { ...STOCK_POLICIES, group: () => [] }
    const { asked, layer } = scripted("q")
    const report = await Effect.runPromise(reviewPullRequest(repo, PULL.number, { ...REVIEW_OPTIONS, turns: 1, focus: "groups", verify: false }, onlyDocs).pipe(Effect.provide(layer.pipe(Layer.provideMerge(Layer.mergeAll(layers, modelSpendMemory))))))
    expect<unknown>([report.focus, report.groups, report.notes, asked.length, asked[0]?.prompt.prefix.length]).toEqual(["whole", [], [NO_GROUP_NOTE], 1, 2])
  })

  test("focused: a group starts only while the find stage has room; the rest are listed as not reviewed", async () => {
    const { asked, layer } = scripted("total += value * 1")
    const report = await reviewWith(layer, { ...REVIEW_OPTIONS, focus: "groups", verify: false, budget: { total: 0.5, find: 0.001, verify: 0.2 } })
    expect<unknown>([asked.length, report.groups.map((run) => [Option.isSome(run.turn), run.notReviewed]), report.turns]).toEqual([0, report.groups.map(() => [false, NOT_REVIEWED_BECAUSE.spent]), []])
  })

  test("with the vote on, a bucket one turn found is left out; with checks off, the kept buckets are reported unchecked", async () => {
    const { asked, layer } = scripted("total += value * 1")
    const report = await reviewWith(layer, { ...REVIEW_OPTIONS, turns: 1, vote: true, verify: false })
    // A lone turn keeps its closing reserve back: $0.10, within half the find stage.
    expect<unknown>([asked.length, asked[0]?.options, report.buckets.map((bucket) => bucket.why), report.verdicts, report.reported]).toEqual([1, { maxSteps: 4, reserve: 0.1 }, ["one-vote"], [], []])
  })
})
