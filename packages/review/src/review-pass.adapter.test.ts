import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { ModelSpend, modelSpendMemory } from "@xandreed/core"
import { gitCheckout } from "./checkout-git.adapter.js"
import { Checkout } from "./checkout.port.js"
import type { FileDiff } from "./diff.entity.js"
import { parseUnifiedDiff } from "./diff.entity.functions.js"
import { PassNumber } from "./finding.entity.js"
import { findingsInMemory } from "./findings.adapter.js"
import { Findings } from "./findings.port.js"
import { gitFixture } from "./git-fixture.testing.js"
import { hostShell } from "./host-shell.adapter.js"
import { BranchName, CommitSha, FetchRef, RepoName } from "./pull-request.entity.js"
import { DEFAULT_REVIEW_MODEL } from "./review-model.entity.js"
import { reviewModel } from "./review-model.adapter.js"
import { kernelPasses } from "./review-pass.adapter.js"
import { ReviewPasses } from "./review-pass.port.js"

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

/** An answer that asks for tools, in order. */
const asks = (...calls: ReadonlyArray<readonly [string, unknown]>) => sse([
  { choices: [{ delta: { tool_calls: calls.map(([name, params], index) => ({ index, id: `c${index}`, type: "function", function: { name, arguments: JSON.stringify(params) } })) }, finish_reason: "tool_calls" }] },
  usage(1_000, 800, 50, 0.0004),
])

/** An answer in words, finished as `finish` says. */
const says = (text: string, finish = "stop") => sse([{ choices: [{ delta: { content: text }, finish_reason: finish }] }, usage(1_200, 1_000, 20, 0.0002)])

/** An endpoint that answers each request with the script's next answer (the last one again past its end), and keeps what it was sent. */
const endpoint = (script: ReadonlyArray<string | { readonly status: number; readonly body: string }>) => {
  const sent: Array<ReadonlyArray<{ readonly role: string; readonly content: unknown }>> = []
  const fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body: unknown = JSON.parse(await new Response(init?.body ?? "").text())
    sent.push(typeof body === "object" && body !== null && "messages" in body && Array.isArray(body.messages) ? body.messages : [])
    const next = script[Math.min(sent.length, script.length) - 1] ?? says("")
    return typeof next === "string"
      ? new Response(next, { status: 200, headers: { "content-type": "text/event-stream" } })
      : new Response(next.body, { status: next.status, headers: { "content-type": "application/json" } })
  }, { preconnect: () => {} })
  return { fetch, sent }
}

const PROMPT = { prefix: [{ role: "system" as const, content: "The system text." }, { role: "user" as const, content: "The pull request." }], tail: "Review it." }

/** One pass over the fixture's head with the scripted endpoint: its result, the findings, the ledger's settled total and the requests. */
const pass = async (script: Parameters<typeof endpoint>[0], options: { readonly maxSteps?: number; readonly maxCost?: number } = {}) => {
  const { fetch, sent } = endpoint(script)
  const journalDir = join(mkdtempSync(join(fixture.root, "review-")), "pass-1")
  const needs = Layer.mergeAll(checkoutLayer, findingsInMemory, modelSpendMemory)
  const layers = kernelPasses.pipe(Layer.provideMerge(reviewModel({ ...DEFAULT_REVIEW_MODEL, model: "m" }, Redacted.make("test-key"), options.maxCost ?? 0.05).pipe(Layer.provideMerge(needs))))
  const ran = await Effect.runPromise(Effect.gen(function* () {
    const result = yield* (yield* ReviewPasses).run({ prompt: PROMPT, reviewed: { repo, at: head, files, pass: PassNumber.make(1) }, journalDir, options: { maxSteps: options.maxSteps ?? 16 } })
    return { result, findings: yield* (yield* Findings).all, settled: (yield* (yield* ModelSpend).totals).settled }
  }).pipe(Effect.provide(layers), Effect.provideService(FetchHttpClient.Fetch, fetch)))
  return { ...ran, sent, journal: existsSync(journalDir) ? readdirSync(journalDir) : [] }
}

const FINDING = { path: "src/sum.ts", line: 4, kind: "bug", severity: "low", claim: "Multiplying by one changes nothing.", evidence: "total += value * 1" }

describe("a pass over the kernel", () => {
  test("the model reads, reports, and answers: the finding recorded, each call's tokens and cost, the files opened, the journal kept", async () => {
    const ran = await pass([asks(["readLines", { path: "src/sum.ts" }], ["reportFinding", FINDING]), says("One bug: a multiplication by one.")])
    expect<unknown>(ran.result).toEqual({
      pass: 1,
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

  test("the step cap ends a pass that keeps asking, with the findings so far", async () => {
    const ran = await pass([asks(["reportFinding", FINDING]), asks(["listFiles", { glob: "src/*" }])], { maxSteps: 3 })
    expect([ran.result.ended, ran.result.calls.length, ran.findings.length, ran.sent.length]).toEqual([{ _tag: "StepCap", steps: 3 }, 3, 1, 3])
  })

  test("the spend cap refuses a call before it is sent: the pass ends, incomplete, with nothing spent", async () => {
    const ran = await pass([says("never sent")], { maxCost: 0.000_01 })
    expect([ran.result.ended._tag, ran.result.calls, ran.sent.length, ran.settled]).toEqual(["SpendRefused", [{ step: 1, tokens: Option.none(), cost: 0 }], 0, 0])
  })

  test("an answer cut at the output cap ends the pass, incomplete, after its findings", async () => {
    const ran = await pass([asks(["reportFinding", FINDING]), says("The second finding is", "length")])
    expect([ran.result.ended, ran.result.calls.length, ran.findings.length]).toEqual([{ _tag: "OutputCut" }, 2, 1])
  })

  test("a call the provider refuses ends the pass, incomplete, in the provider's words", async () => {
    const ran = await pass([{ status: 400, body: JSON.stringify({ error: { message: "the model does not exist" } }) }])
    expect(ran.result.ended._tag).toBe("ModelFailed")
    expect(ran.result.calls.length).toBe(1)
  })
})
