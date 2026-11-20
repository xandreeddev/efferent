import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer, Option, Redacted } from "effect"
import type { Context } from "effect"
import { FetchHttpClient } from "effect/http"
import { JournalStorage, ModelSpend, modelSpendMemory } from "@xandreed/core"
import { flatMemory, Memory } from "@xandreed/sdk"
import { gitCheckout } from "./checkout-git.adapter.js"
import { Checkout } from "./checkout.port.js"
import type { FileDiff } from "./diff.entity.js"
import { parseUnifiedDiff } from "./diff.entity.functions.js"
import { CheckNumber, PassNumber } from "./finding.entity.js"
import { findingsInMemory } from "./findings.adapter.js"
import { Findings } from "./findings.port.js"
import { gitFixture } from "./git-fixture.testing.js"
import { hostShell } from "./host-shell.adapter.js"
import { BranchName, CommitSha, FetchRef, RepoName } from "./pull-request.entity.js"
import { DEFAULT_BUDGET, DEFAULT_MAX_COST, DEFAULT_REVIEW_MODEL } from "./review-model.entity.js"
import type { ReviewModel } from "./review-model.entity.js"
import { reviewModel } from "./review-model.adapter.js"
import { withEffort } from "./review-model.entity.functions.js"
import { REQUEST_SLACK_BYTES } from "./file-group.entity.js"
import { firstCallBytes } from "./file-group.entity.functions.js"
import { kernelPasses } from "./review-pass.adapter.js"
import type { KernelPassesOptions } from "./review-pass.adapter.js"
import { PassJournalFailed } from "./review-pass.entity.js"
import { ReviewPasses } from "./review-pass.port.js"
import type { ReviewStage } from "./review-tools.entity.js"
import { stageSpend } from "./stage-spend.adapter.js"
import type { StageLedger } from "./stage-spend.port.js"
import { DEFAULT_CLOSING_RESERVE } from "./review.entity.js"

const fixture = gitFixture()
afterAll(() => fixture.cleanup())

const repo = RepoName.make("owner/project")
const head = CommitSha.make(fixture.head)
const cacheRoot = mkdtempSync(join(fixture.root, "cache-"))
const checkoutLayer = gitCheckout({ cacheRoot, remoteUrl: () => fixture.remote, transports: ["file"] }).pipe(Layer.provide(hostShell({ cwd: fixture.root, env: fixture.env })))

let files: ReadonlyArray<FileDiff> = []
beforeAll(async () => {
  files = await Effect.runPromise(Effect.gen(function* () {
    const checkout = yield* Checkout
    yield* checkout.fetch(repo, { ref: BranchName.make("main"), sha: CommitSha.make(fixture.left) }, { sha: head, fetchRef: FetchRef.make("refs/pull/1/head") })
    return yield* Effect.fromResult(parseUnifiedDiff(yield* checkout.diff(repo, CommitSha.make(fixture.left), head)))
  }).pipe(Effect.provide(checkoutLayer)))
})

const sse = (chunks: ReadonlyArray<unknown>) => `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`
const usage = (input: number, cached: number, output: number, cost: number) => ({ choices: [], usage: { prompt_tokens: input, completion_tokens: output, prompt_tokens_details: { cached_tokens: cached }, cost } })

/** An answer that asks for tools, in order, finished as `finish` says. */
const asksEnding = (finish: string, calls: ReadonlyArray<readonly [string, unknown]>) => sse([
  { choices: [{ delta: { tool_calls: calls.map(([name, params], index) => ({ index, id: `c${index}`, type: "function", function: { name, arguments: JSON.stringify(params) } })) }, finish_reason: finish }] },
  usage(1_000, 800, 50, 0.0004),
])

/** An answer that asks for tools, in order. */
const asks = (...calls: ReadonlyArray<readonly [string, unknown]>) => asksEnding("tool_calls", calls)

/** An answer in words, finished as `finish` says. */
const says = (text: string, finish = "stop") => sse([{ choices: [{ delta: { content: text }, finish_reason: finish }] }, usage(1_200, 1_000, 20, 0.0002)])

/** A request as the endpoint kept it: its messages and the names of the tools it offered. */
interface Sent {
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content: unknown }>
  readonly tools: ReadonlyArray<string>
  /** The body's `reasoning` field, as sent (none: absent). */
  readonly reasoning: unknown
  /** The body's size in bytes, as the ledger counts it. */
  readonly bytes?: number
}

/** A request's body, read loosely: the test's own fake wire. */
const sentOf = (body: unknown): Sent => {
  const messages = typeof body === "object" && body !== null && "messages" in body && Array.isArray(body.messages) ? body.messages : []
  const tools = typeof body === "object" && body !== null && "tools" in body && Array.isArray(body.tools) ? body.tools.map((tool: { readonly function?: { readonly name?: string } }) => tool.function?.name ?? "") : []
  const reasoning = typeof body === "object" && body !== null && "reasoning" in body ? body.reasoning : undefined
  return { messages, tools, reasoning }
}

/** An endpoint that answers each request with the script's next answer (the last one again past its end), and keeps what it was sent. */
const endpoint = (script: ReadonlyArray<string | { readonly status: number; readonly body: string }>) => {
  const kept: Array<Sent> = []
  const fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = await new Response(init?.body ?? "").text()
    kept.push({ ...sentOf(JSON.parse(body)), bytes: new TextEncoder().encode(body).length })
    const next = script[Math.min(kept.length, script.length) - 1] ?? says("")
    return typeof next === "string"
      ? new Response(next, { status: 200, headers: { "content-type": "text/event-stream" } })
      : new Response(next.body, { status: next.status, headers: { "content-type": "application/json" } })
  }, { preconnect: () => {} })
  return { fetch, sent: kept.map((one) => one.messages), kept }
}

const PROMPT = { prefix: [{ role: "system" as const, content: "The system text." }, { role: "user" as const, content: "The pull request." }], tail: "Review it." }

interface PassOptionsForTest {
  readonly maxSteps?: number
  readonly maxCost?: number
  readonly price?: ReviewModel["price"]
  readonly passes?: Omit<KernelPassesOptions, "model">
  readonly stage?: ReviewStage
  readonly reserve?: number
  /** Whether the input carries `onFirstAnswer`, as the first pass's does (the default). */
  readonly waitedOn?: boolean
  /** The prompt, `PROMPT` by default. */
  readonly prompt?: { readonly prefix: ReadonlyArray<{ readonly role: "system" | "user"; readonly content: string }>; readonly tail: string }
  /** Whether the input asks its first call once more after a failure worth another try without `onFirstAnswer`. */
  readonly retryFirstCall?: boolean
}

const testModel = (options: PassOptionsForTest) =>
  reviewModel({ ...DEFAULT_REVIEW_MODEL, model: "m", price: options.price ?? DEFAULT_REVIEW_MODEL.price }, Redacted.make("test-key"), options.maxCost ?? 0.05)

/** One pass over the fixture's head with the scripted endpoint: its result, the findings, the ledger's settled total and the requests. */
const pass = async (script: Parameters<typeof endpoint>[0], options: PassOptionsForTest = {}) => {
  const { fetch, kept } = endpoint(script)
  const journalAt = join(mkdtempSync(join(fixture.root, "review-")), "pass-1")
  const needs = Layer.mergeAll(checkoutLayer, findingsInMemory, modelSpendMemory)
  const layers = kernelPasses({ model: testModel(options), ...options.passes }).pipe(Layer.provideMerge(needs))
  const stage = options.stage ?? { _tag: "Find", pass: PassNumber.make(1) }
  /** Each first-answer signal, with how many requests had been sent when it came. */
  const signals: Array<readonly [boolean, number]> = []
  const ran = await Effect.runPromise(Effect.gen(function* () {
    const root = yield* ModelSpend
    const spend = yield* stageSpend(root, Option.none())
    const result = yield* (yield* ReviewPasses).run({
      prompt: options.prompt ?? PROMPT,
      reviewed: { run: "run-1", repo, at: head, files, stage },
      journalAt,
      options: { maxSteps: options.maxSteps ?? 16, reserve: options.reserve ?? 0 },
      spend,
      ...(options.retryFirstCall === undefined ? {} : { retryFirstCall: options.retryFirstCall }),
      ...(options.waitedOn === false ? {} : {
        onFirstAnswer: (answered: boolean) => Effect.sync(() => {
          signals.push([answered, kept.length])
        }),
      }),
    })
    const findings = yield* Findings
    return { result, findings: yield* findings.all("run-1"), verdict: yield* findings.verdictOf("run-1", CheckNumber.make(1)), settled: (yield* root.totals).settled }
  }).pipe(Effect.provide(layers), Effect.provideService(FetchHttpClient.Fetch, fetch)))
  return { ...ran, signals, sent: kept.map((one) => one.messages), kept, journal: existsSync(journalAt) ? readdirSync(journalAt) : [] }
}

const FINDING = { path: "src/sum.ts", line: 4, kind: "bug", severity: "low", claim: "Multiplying by one changes nothing.", evidence: "total += value * 1" }

describe("a focused pass and its check on the wire", () => {
  const group = [{ role: "system" as const, content: "The system text." }, { role: "user" as const, content: "The pull request and every changed file." }, { role: "user" as const, content: "The files under review here: src/sum.ts." }]

  test("a check's request starts with its pass's first three messages, byte for byte; only the tail after them differs", async () => {
    const found = await pass([asks(["reportFinding", FINDING]), says("One.")], { prompt: { prefix: group, tail: "Find." } })
    const checked = await pass([asks(["verdict", { outcome: "confirmed", reason: "r", quote: "total += value * 1" }])], { prompt: { prefix: group, tail: "Check." }, stage: { _tag: "Verify", check: CheckNumber.make(1) } })
    const first = (sent: ReadonlyArray<Sent>) => JSON.stringify(sent[0]?.messages.slice(0, 3))
    expect([first(found.kept), first(found.kept) === first(checked.kept), found.kept[0]?.messages[3], checked.kept[0]?.messages[3]]).toEqual([
      JSON.stringify(group.map((part) => ({ role: part.role, content: part.content }))), true, { role: "user", content: "Find." }, { role: "user", content: "Check." },
    ])
  })

  test("the checks' model is the passes' unless given: another effort is sent by the checks alone", async () => {
    const none = reviewModel(withEffort({ ...DEFAULT_REVIEW_MODEL, model: "m" }, "none"), Redacted.make("test-key"), 0.05)
    const found = await pass([says("Nothing.")], { passes: { verifyModel: none } })
    const checked = await pass([asks(["verdict", { outcome: "refuted", reason: "r", quote: "q" }])], { passes: { verifyModel: none }, stage: { _tag: "Verify", check: CheckNumber.make(1) } })
    const same = await pass([asks(["verdict", { outcome: "refuted", reason: "r", quote: "q" }])], { stage: { _tag: "Verify", check: CheckNumber.make(1) } })
    expect([found.kept[0]?.reasoning, checked.kept[0]?.reasoning, same.kept[0]?.reasoning]).toEqual([undefined, { enabled: false }, undefined])
  })
})

describe("a pass over the kernel", () => {
  test("the model reads, reports, and answers: the finding recorded, each call's tokens and cost, the files opened, the journal kept", async () => {
    const ran = await pass([asks(["readLines", { path: "src/sum.ts" }], ["reportFinding", FINDING]), says("One bug: a multiplication by one.")])
    expect<unknown>(ran.result).toEqual({
      stage: { _tag: "Find", pass: 1 },
      session: expect.objectContaining({ _tag: "Some" }),
      ended: { _tag: "Answered", summary: "One bug: a multiplication by one." },
      calls: [{ step: 1, tokens: Option.some({ input: 1_000, cached: 800, output: 50 }), cost: 0.0004 }, { step: 2, tokens: Option.some({ input: 1_200, cached: 1_000, output: 20 }), cost: 0.0002 }],
      opened: ["src/sum.ts"],
    })
    expect<unknown>(ran.findings).toEqual([{ ...FINDING, pass: 1, number: 1 }])
    expect(Math.round(ran.settled * 1e6) / 1e6).toBe(0.0006)
    // Each request starts with the prefix, unchanged; then the tail, the calls and their results, as the memory gives them.
    expect(ran.sent.map((messages) => messages.map((message) => message.role))).toEqual([["system", "user", "user"], ["system", "user", "user", "assistant", "tool", "tool"]])
    expect(ran.sent.map((messages) => messages.slice(0, 3).map((message) => message.content))).toEqual([["The system text.", "The pull request.", "Review it."], ["The system text.", "The pull request.", "Review it."]])
    expect(ran.journal.length).toBeGreaterThan(0)
  })

  test("the step cap ends a pass that keeps asking, with the findings so far, after one more call", async () => {
    const ran = await pass([asks(["reportFinding", FINDING]), asks(["listFiles", { glob: "src/*" }])], { maxSteps: 3 })
    expect([ran.result.ended, ran.result.calls.length, ran.findings.length, ran.sent.length]).toEqual([{ _tag: "StepCap", steps: 3, summary: "", why: "" }, 4, 1, 4])
  })

  test("a closing call that fails is said: the step cap with why", async () => {
    const ran = await pass([asks(["listFiles", { glob: "src/*" }]), { status: 400, body: JSON.stringify({ error: { message: "the model does not exist" } }) }], { maxSteps: 1 })
    expect([ran.result.ended._tag, ran.result.ended._tag === "StepCap" && ran.result.ended.why.includes("the model does not exist")]).toEqual(["StepCap", true])
  })

  test("onFirstAnswer through the real loop: once, after the first call returns, true when it answered; false when it failed, or when the pass ended before any call", async () => {
    const answered = await pass([asks(["listFiles", { glob: "src/*" }]), says("Done.")])
    const refused = await pass([says("never sent")], { maxCost: 0.000_01 })
    const broken = await pass([says("never sent")], { passes: { journal: () => Layer.effect(JournalStorage, Effect.fail(new PassJournalFailed({ message: "the disk is full" }))) } })
    expect([answered.signals, refused.signals, broken.signals]).toEqual([[[true, 1]], [[false, 0]], [[false, 0]]])
  })

  test("the first call the other passes wait on is asked once more after a failure worth another try; a refusal, a second failure and a pass no one waits on are not", async () => {
    const unavailable = { status: 503, body: JSON.stringify({ error: { message: "the provider is overloaded" } }) }
    const refusedCall = { status: 400, body: JSON.stringify({ error: { message: "the model does not exist" } }) }
    const limited = { status: 429, body: JSON.stringify({ error: { message: "slow down" } }) }
    const blip = await pass([unavailable, says("Done.")])
    const rateLimited = await pass([limited, says("Done.")])
    const twice = await pass([unavailable, unavailable, says("Done.")])
    const refused = await pass([refusedCall, says("Done.")])
    const alone = await pass([unavailable, says("Done.")], { waitedOn: false })
    expect([blip.result.ended, blip.signals, blip.sent.length, blip.result.calls.map((call) => [call.step, Option.isSome(call.tokens)])]).toEqual([{ _tag: "Answered", summary: "Done." }, [[true, 2]], 2, [[1, false], [1, true]]])
    expect([rateLimited.result.ended._tag, rateLimited.sent.length]).toEqual(["Answered", 2])
    expect([twice.result.ended._tag, twice.signals, twice.sent.length]).toEqual(["ModelFailed", [[false, 2]], 2])
    expect([refused.result.ended._tag, refused.signals, refused.sent.length]).toEqual(["ModelFailed", [[false, 1]], 1])
    expect([alone.result.ended._tag, alone.sent.length]).toEqual(["ModelFailed", 1])
  })

  test("a focused group's pass (retryFirstCall, no one waiting) asks its first call once more after a 503, and not after a 400", async () => {
    const unavailable = { status: 503, body: JSON.stringify({ error: { message: "the provider is overloaded" } }) }
    const refusedCall = { status: 400, body: JSON.stringify({ error: { message: "the model does not exist" } }) }
    const blip = await pass([unavailable, says("Done.")], { waitedOn: false, retryFirstCall: true })
    const refused = await pass([refusedCall, says("Done.")], { waitedOn: false, retryFirstCall: true })
    expect([blip.result.ended._tag, blip.sent.length, refused.result.ended._tag, refused.sent.length]).toEqual(["Answered", 2, "ModelFailed", 1])
  })

  test("firstCallBytes counts at least the first request's body the ledger holds on, for a newline- and quote-heavy prompt", async () => {
    const prompt = { prefix: [{ role: "system" as const, content: "The system text." }, { role: "user" as const, content: `${"a line\n".repeat(4_000)}${"\"q\" ".repeat(2_000)}` }], tail: "Review it." }
    const ran = await pass([says("Done.")], { prompt, waitedOn: false })
    const sent = ran.kept[0]?.bytes ?? 0
    // Within the slack it keeps for the tools: never under the body, and not far over it.
    expect([sent > 40_000, firstCallBytes(prompt) >= sent, firstCallBytes(prompt) - sent < REQUEST_SLACK_BYTES]).toEqual([true, true, true])
  })

  test("a spend refusal mid-pass, with a reserve kept back from the start: the reserve released, the host's note, and the closing call's finding kept", async () => {
    // Each call holds $0.004096 (4,096 tokens of output at $1 a million) and is billed $0.0004. With $0.0045 kept back
    // under a cap of $0.0089, the first call fits and the second does not; released, the reserve makes room to close.
    const closingAnswer = asks(["reportFinding", FINDING])
    const price = { input: 0, output: 1, cacheRead: 0 }
    const kept = await pass([asks(["listFiles", { glob: "src/*" }]), closingAnswer], { maxCost: 0.0089, price, reserve: 0.0045 })
    const none = await pass([asks(["listFiles", { glob: "src/*" }]), closingAnswer], { maxCost: 0.0089 - 0.0045, price })
    expect([kept.result.ended._tag, kept.findings.length, kept.kept.length, none.result.ended._tag, none.findings.length, none.kept.length]).toEqual(["SpendRefused", 1, 2, "SpendRefused", 0, 1])
    expect(kept.kept.at(-1)?.messages.at(-1)).toEqual({ role: "user", content: "[Host note: You have used the tool calls this review allows. Report now with reportFinding each problem you found and have not reported, then answer with a one-line summary. No other tool runs now.]" })
  })

  test("a closing call after a spend refusal that fails is said beside the refusal", async () => {
    const price = { input: 0, output: 1, cacheRead: 0 }
    const ran = await pass([asks(["listFiles", { glob: "src/*" }]), { status: 400, body: JSON.stringify({ error: { message: "the model does not exist" } }) }], { maxCost: 0.0089, price, reserve: 0.0045 })
    expect([ran.result.ended._tag, ran.result.ended._tag === "SpendRefused" && ran.result.ended.message.includes("; its closing call failed: ") && ran.result.ended.message.includes("the model does not exist")]).toEqual(["SpendRefused", true])
  })

  test("at the step cap: the host's note, the same tools offered, and only the last answer's reportFinding calls run", async () => {
    const lastAnswer = sse([
      { choices: [{ delta: { content: "One more problem.", tool_calls: [
        { index: 0, id: "c0", type: "function", function: { name: "readLines", arguments: JSON.stringify({ path: "src/sum.ts" }) } },
        { index: 1, id: "c1", type: "function", function: { name: "reportFinding", arguments: JSON.stringify(FINDING) } },
      ] }, finish_reason: "tool_calls" }] },
      usage(1_000, 800, 50, 0.0004),
    ])
    const ran = await pass([asks(["listFiles", { glob: "src/*" }]), asks(["listFiles", { glob: "*" }]), lastAnswer], { maxSteps: 2 })
    expect<unknown>([ran.result.ended, ran.findings.length, ran.result.opened, ran.kept.length]).toEqual([{ _tag: "StepCap", steps: 2, summary: "One more problem.", why: "" }, 1, [], 3])
    expect(ran.kept.at(-1)?.messages.at(-1)).toEqual({ role: "user", content: "[Host note: You have used the tool calls this review allows. Report now with reportFinding each problem you found and have not reported, then answer with a one-line summary. No other tool runs now.]" })
    expect(ran.kept.map((one) => one.tools)).toEqual([0, 1, 2].map(() => ["readLines", "searchCode", "listFiles", "readDiff", "reportFinding", "verdict"]))
  })

  test("a check ends once its verdict is recorded; reportFinding is refused in a check", async () => {
    const VERDICT = { outcome: "confirmed", reason: "It multiplies by one.", quote: "total += value * 1" }
    const ran = await pass([asks(["reportFinding", FINDING]), asks(["verdict", VERDICT]), says("never sent")], { stage: { _tag: "Verify", check: CheckNumber.make(1) } })
    expect<unknown>([ran.result.ended, ran.findings, ran.verdict, ran.kept.length]).toEqual([{ _tag: "Judged" }, [], Option.some({ ...VERDICT, check: 1 }), 2])
    expect(JSON.stringify(ran.kept[1]?.messages.at(-1))).toContain("You are checking a finding, not reporting new ones: call verdict with your verdict on it.")
  })

  test("a check that answers in words is asked once more for its verdict: the host's note, the same tools offered; a verdict in text is never one", async () => {
    const VERDICT = { outcome: "confirmed", reason: "It multiplies by one.", quote: "total += value * 1" }
    const check = { stage: { _tag: "Verify", check: CheckNumber.make(1) } } as const
    const judged = await pass([says("Verdict: confirmed."), asks(["verdict", VERDICT]), says("never sent")], check)
    const words = await pass([says("Verdict: confirmed."), says("Verdict: confirmed, again."), says("never sent")], check)
    expect<unknown>([judged.result.ended, judged.verdict, judged.kept.length]).toEqual([{ _tag: "Judged" }, Option.some({ ...VERDICT, check: 1 }), 2])
    expect(judged.kept.at(-1)?.messages.at(-1)).toEqual({ role: "user", content: "[Host note: This check ends now. Call verdict now with your outcome, your reason and a quote of the cited lines your verdict rests on: a verdict written as text is not counted. No other tool runs now.]" })
    expect(judged.kept.map((one) => one.tools)).toEqual([0, 1].map(() => ["readLines", "searchCode", "listFiles", "readDiff", "reportFinding", "verdict"]))
    expect<unknown>([words.result.ended, words.verdict, words.kept.length]).toEqual([{ _tag: "Answered", summary: "Verdict: confirmed." }, Option.none(), 2])
    // A pass that answers in words has answered: it is not asked again.
    const answered = await pass([says("Done."), says("never sent")])
    expect([answered.result.ended._tag, answered.kept.length]).toEqual(["Answered", 1])
  })

  test("a check refused mid-way with a reserve kept back gives its verdict on the closing call and is judged", async () => {
    const VERDICT = { outcome: "refuted", reason: "Multiplying by one is harmless.", quote: "total += value * 1" }
    const price = { input: 0, output: 1, cacheRead: 0 }
    const ran = await pass([asks(["listFiles", { glob: "src/*" }]), asks(["verdict", VERDICT])], { maxCost: 0.0089, price, reserve: 0.0045, stage: { _tag: "Verify", check: CheckNumber.make(1) } })
    expect<unknown>([ran.result.ended, ran.verdict, ran.kept.length]).toEqual([{ _tag: "Judged" }, Option.some({ ...VERDICT, check: 1 }), 2])
  })

  test("a pass refuses verdict: there is no finding to check", async () => {
    const ran = await pass([asks(["verdict", { outcome: "refuted", reason: "r", quote: "q" }]), says("Done.")])
    expect<unknown>([ran.result.ended, ran.verdict]).toEqual([{ _tag: "Answered", summary: "Done." }, Option.none()])
    expect(JSON.stringify(ran.kept[1]?.messages.at(-1))).toContain("There is no finding to check in this review: report each problem with reportFinding.")
  })

  test("the spend cap refuses a call before it is sent: the pass ends, incomplete, with nothing spent", async () => {
    const ran = await pass([says("never sent")], { maxCost: 0.000_01 })
    expect([ran.result.ended._tag, ran.result.calls, ran.sent.length, ran.settled]).toEqual(["SpendRefused", [{ step: 1, tokens: Option.none(), cost: 0 }], 0, 0])
  })

  test("an answer cut at the output cap ends the pass, incomplete, after its findings", async () => {
    const ran = await pass([asks(["reportFinding", FINDING]), says("The second finding is", "length")])
    expect([ran.result.ended, ran.result.calls.length, ran.findings.length]).toEqual([{ _tag: "OutputCut" }, 2, 1])
  })

  test("an answer cut at the output cap still runs the calls it asked for whole: its finding is kept", async () => {
    const ran = await pass([asksEnding("length", [["reportFinding", FINDING]])])
    expect([ran.result.ended, ran.result.calls.length, ran.findings.length, ran.sent.length]).toEqual([{ _tag: "OutputCut" }, 1, 1, 1])
  })

  test("a spend refusal mid-pass keeps the findings and the cost of the calls before it", async () => {
    // Each call holds its 4,096 tokens of output at $1 a million (nothing for input): $0.004096. The first fits under
    // $0.0044 and is billed $0.0004; the second would take the ledger to $0.004496, and is refused before it is sent.
    const ran = await pass([asks(["reportFinding", FINDING]), says("never sent")], { maxCost: 0.0044, price: { input: 0, output: 1, cacheRead: 0 } })
    expect<unknown>([ran.result.ended._tag, ran.result.calls, ran.findings.length, ran.sent.length, Math.round(ran.settled * 1e6) / 1e6]).toEqual([
      "SpendRefused", [{ step: 1, tokens: Option.some({ input: 1_000, cached: 800, output: 50 }), cost: 0.0004 }, { step: 2, tokens: Option.none(), cost: 0 }], 1, 1, 0.0004,
    ])
  })

  test("a call the provider refuses ends the pass, incomplete, in the provider's words", async () => {
    const ran = await pass([{ status: 400, body: JSON.stringify({ error: { message: "the model does not exist" } }) }])
    expect([ran.result.ended._tag, ran.result.ended._tag === "ModelFailed" && ran.result.ended.message.includes("the model does not exist"), ran.result.calls.length]).toEqual(["ModelFailed", true, 1])
  })

  test("a journal that cannot be opened ends the pass, incomplete, in words, with no session and no call", async () => {
    const broken: Omit<KernelPassesOptions, "model"> = { journal: () => Layer.effect(JournalStorage, Effect.fail(new PassJournalFailed({ message: "the disk is full" }))) }
    const ran = await pass([says("never sent")], { passes: broken })
    expect<unknown>([ran.result.ended, ran.result.session, ran.result.calls, ran.sent.length]).toEqual([{ _tag: "JournalFailed", message: "the disk is full" }, Option.none(), [], 0])
  })

  test("each part is the host's to swap: a memory of its own is the one asked for each step's context", async () => {
    let asked = 0
    // A memory of the host's: the flat memory, counted.
    const memory = Layer.effect(Memory, Effect.gen(function* () {
      const inner = yield* Memory
      return Memory.of({ context: (session) => Effect.andThen(Effect.sync(() => {
        asked += 1
      }), inner.context(session)) })
    })).pipe(Layer.provide(flatMemory))
    const ran = await pass([asks(["listFiles", { glob: "*" }]), says("Nothing.")], { passes: { memory } })
    expect([asked, ran.result.ended._tag, ran.sent.length]).toEqual([2, "Answered", 2])
  })
})

describe("three passes at once under the review's budget", () => {
  // The size of the longest live single pass's last request: about 300 KB, held at 1 byte a token at $0.30 a million ($0.09),
  // plus 4,096 tokens of output at $1.20 a million; each call billed $0.0025, so sixteen calls settle $0.04.
  const PREFIX = [{ role: "system" as const, content: "The system text." }, { role: "user" as const, content: "x".repeat(300_000) }]
  const billed = (answer: string) => answer.replace(/"cost":[0-9.]+/, "\"cost\":0.0025")
  /** An endpoint for several passes at once: each request answered by how far its own conversation is, a call for its first fifteen steps, then words. */
  const steady = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const asked = sentOf(JSON.parse(await new Response(init?.body ?? "").text())).messages.filter((message) => message.role === "assistant").length
    return new Response(billed(asked < 15 ? asks(["listFiles", { glob: "src/*" }]) : says("Done.")), { status: 200, headers: { "content-type": "text/event-stream" } })
  }, { preconnect: () => {} })

  /** `count` passes at once on `spend(root)`, the review's ledger capped at the default total, each keeping `reserve` back: how each ended and what was settled. */
  const passesAtOnce = (spend: (root: Context.Service.Shape<typeof ModelSpend>) => Effect.Effect<StageLedger>, count = 3, reserve = 0) => {
    const layers = kernelPasses({ model: testModel({ maxCost: DEFAULT_MAX_COST }) }).pipe(Layer.provideMerge(Layer.mergeAll(checkoutLayer, findingsInMemory, modelSpendMemory)))
    const folder = mkdtempSync(join(fixture.root, "three-"))
    return Effect.runPromise(Effect.gen(function* () {
      const root = yield* ModelSpend
      const stage = yield* spend(root)
      const passes = yield* ReviewPasses
      const results = yield* Effect.forEach(Array.from({ length: count }, (_, index) => index + 1), (number) => passes.run({
        prompt: { prefix: PREFIX, tail: "Review it." },
        reviewed: { run: "run-1", repo, at: head, files, stage: { _tag: "Find", pass: PassNumber.make(number) } },
        journalAt: join(folder, `pass-${number}`),
        options: { maxSteps: 16, reserve },
        spend: stage,
      }), { concurrency: "unbounded" })
      return { ended: results.map((result) => result.ended._tag), settled: Math.round((yield* root.totals).settled * 1e6) / 1e6, held: (yield* root.totals).reserved }
    }).pipe(Effect.provide(layers), Effect.provideService(FetchHttpClient.Fetch, steady)))
  }
  const defaultStages = (root: Context.Service.Shape<typeof ModelSpend>) => Effect.flatMap(stageSpend(root, Option.some(DEFAULT_BUDGET.total)), (total) => stageSpend(total, Option.some(DEFAULT_BUDGET.find)))

  test("under the default budget's find stage, none ends on a spend refusal: a call the others' holds crowd out waits", async () => {
    const ran = await passesAtOnce(defaultStages)
    expect(ran).toEqual({ ended: ["Answered", "Answered", "Answered"], settled: 0.12, held: 0 })
  }, 60_000)

  test("why passes beside each other keep nothing back: three each keeping a sixth of the find stage crowd out each other's calls and end refused", async () => {
    const ran = await passesAtOnce(defaultStages, 3, DEFAULT_BUDGET.find / 6)
    expect([ran.ended.includes("SpendRefused"), ran.held]).toEqual([true, 0])
  }, 60_000)

  test("one pass keeping the default closing reserve back answers under the default budget, and its reserve is released", async () => {
    const ran = await passesAtOnce(defaultStages, 1, DEFAULT_CLOSING_RESERVE)
    expect(ran).toEqual({ ended: ["Answered"], settled: 0.04, held: 0 })
  }, 60_000)

  test("control: on the same cap, a ledger that refuses whatever open holds crowd out ends a pass on a refusal", async () => {
    const ran = await passesAtOnce((root) => Effect.succeed({ ...ModelSpend.of({ ...root, reserve: (request) => root.reserve({ ...request, caps: { total: DEFAULT_BUDGET.find } }) }), keepBack: () => Effect.succeed(Option.none()) }))
    expect(ran.ended).toContain("SpendRefused")
  }, 60_000)
})
