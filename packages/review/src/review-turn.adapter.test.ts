import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { Deferred, Effect, Layer, Match, Option, Redacted, Schema, Stream } from "effect"
import type { Context } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import { JournalStorage, ModelSpend, modelSpendMemory, Sessions } from "@xandreed/core"
import { flatMemory, Memory } from "@xandreed/sdk"
import { anthropicModel } from "@xandreed/sdk/node"
import { gitCheckout } from "./checkout-git.adapter.js"
import { Checkout } from "./checkout.port.js"
import type { FileDiff } from "./diff.entity.js"
import { parseUnifiedDiff } from "./diff.entity.functions.js"
import { CheckNumber, TurnNumber } from "./finding.entity.js"
import { findingsInMemory } from "./findings.adapter.js"
import { Findings } from "./findings.port.js"
import { gitFixture } from "./git-fixture.testing.js"
import { hostShell } from "./host-shell.adapter.js"
import { BranchName, CommitSha, FetchRef, RepoName } from "./pull-request.entity.js"
import { DEFAULT_BUDGET, DEFAULT_MAX_COST, DEFAULT_REVIEW_MODEL, HAIKU_REVIEW_MODEL } from "./review-model.entity.js"
import type { Effort, ReviewModel } from "./review-model.entity.js"
import { reviewModel } from "./review-model.adapter.js"
import { withEffort } from "./review-model.entity.functions.js"
import { REQUEST_SLACK_BYTES } from "./file-group.entity.js"
import { firstCallBytes } from "./file-group.entity.functions.js"
import { kernelTurns } from "./review-turn.adapter.js"
import type { HostTools, KernelTurnsOptions } from "./review-turn.adapter.js"
import { reviewTools } from "./review-tools.adapter.js"
import { CONTEXT_FULL, TurnJournalFailed } from "./review-turn.entity.js"
import { ReviewTurns } from "./review-turn.port.js"
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
  /** Each tool's declaration as sent, in order, as JSON. */
  readonly declared: ReadonlyArray<string>
  /** On the Messages wire, the body's `thinking` and `output_config`, as sent (none: absent). */
  readonly thinking: unknown
}

/** A request's body, read loosely: the test's own fake wire. */
const sentOf = (body: unknown): Sent => {
  const messages = typeof body === "object" && body !== null && "messages" in body && Array.isArray(body.messages) ? body.messages : []
  const tools = typeof body === "object" && body !== null && "tools" in body && Array.isArray(body.tools) ? body.tools.map((tool: { readonly function?: { readonly name?: string } }) => tool.function?.name ?? "") : []
  const declared = typeof body === "object" && body !== null && "tools" in body && Array.isArray(body.tools) ? body.tools.map((tool: unknown) => JSON.stringify(tool)) : []
  const reasoning = typeof body === "object" && body !== null && "reasoning" in body ? body.reasoning : undefined
  const thinking = typeof body === "object" && body !== null && "thinking" in body ? [body.thinking, "output_config" in body ? body.output_config : undefined] : undefined
  return { messages, tools, reasoning, declared, thinking }
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

interface TurnOptionsForTest {
  readonly maxSteps?: number
  readonly maxCost?: number
  readonly price?: ReviewModel["price"]
  readonly turns?: Omit<KernelTurnsOptions, "model">
  readonly stage?: ReviewStage
  readonly reserve?: number
  /** Whether the input carries `onFirstAnswer`, as the first turn's does (the default). */
  readonly waitedOn?: boolean
  /** The prompt, `PROMPT` by default. */
  readonly prompt?: { readonly prefix: ReadonlyArray<{ readonly role: "system" | "user"; readonly content: string }>; readonly tail: string }
  /** Whether the input asks its first call once more after a failure worth another try without `onFirstAnswer`. */
  readonly retryFirstCall?: boolean
  /** The turns over the test's model, in place of `kernelTurns` with `turns`: a host's tools of another type. */
  readonly turnsOf?: (model: Layer.Layer<LanguageModel.LanguageModel, never, ModelSpend>) => Layer.Layer<ReviewTurns, never, Checkout | Findings>
}

const testModel = (options: TurnOptionsForTest) =>
  reviewModel({ ...DEFAULT_REVIEW_MODEL, model: "m", price: options.price ?? DEFAULT_REVIEW_MODEL.price }, Redacted.make("test-key"), options.maxCost ?? 0.05)

/** One turn over the fixture's head with the scripted endpoint: its result, the findings, the ledger's settled total and the requests. */
const turn = async (script: Parameters<typeof endpoint>[0], options: TurnOptionsForTest = {}) => {
  const { fetch, kept } = endpoint(script)
  const journalAt = join(mkdtempSync(join(fixture.root, "review-")), "turn-1")
  const needs = Layer.mergeAll(checkoutLayer, findingsInMemory, modelSpendMemory)
  const turns = options.turnsOf === undefined ? kernelTurns({ model: testModel(options), ...options.turns }) : options.turnsOf(testModel(options))
  const layers = turns.pipe(Layer.provideMerge(needs))
  const stage = options.stage ?? { _tag: "Find", turn: TurnNumber.make(1) }
  /** Each first-answer signal, with how many requests had been sent when it came. */
  const signals: Array<readonly [boolean, number]> = []
  const ran = await Effect.runPromise(Effect.gen(function* () {
    const root = yield* ModelSpend
    const spend = yield* stageSpend(root, Option.none())
    const result = yield* (yield* ReviewTurns).run({
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

describe("a focused turn and its check on the wire", () => {
  const group = [{ role: "system" as const, content: "The system text." }, { role: "user" as const, content: "The pull request and every changed file." }, { role: "user" as const, content: "The files under review here: src/sum.ts." }]

  test("a check's request starts with its turn's first three messages, byte for byte; only the tail after them differs", async () => {
    const found = await turn([asks(["reportFinding", FINDING]), says("One.")], { prompt: { prefix: group, tail: "Find." } })
    const checked = await turn([asks(["verdict", { outcome: "confirmed", reason: "r", quote: "total += value * 1" }])], { prompt: { prefix: group, tail: "Check." }, stage: { _tag: "Verify", check: CheckNumber.make(1) } })
    const first = (sent: ReadonlyArray<Sent>) => JSON.stringify(sent[0]?.messages.slice(0, 3))
    expect([first(found.kept), first(found.kept) === first(checked.kept), found.kept[0]?.messages[3], checked.kept[0]?.messages[3]]).toEqual([
      JSON.stringify(group.map((part) => ({ role: part.role, content: part.content }))), true, { role: "user", content: "Find." }, { role: "user", content: "Check." },
    ])
  })

  test("the checks' model is the turns' unless given: another effort is sent by the checks alone", async () => {
    const none = reviewModel(withEffort({ ...DEFAULT_REVIEW_MODEL, model: "m" }, "none"), Redacted.make("test-key"), 0.05)
    const found = await turn([says("Nothing.")], { turns: { verifyModel: none } })
    const checked = await turn([asks(["verdict", { outcome: "refuted", reason: "r", quote: "q" }])], { turns: { verifyModel: none }, stage: { _tag: "Verify", check: CheckNumber.make(1) } })
    const same = await turn([asks(["verdict", { outcome: "refuted", reason: "r", quote: "q" }])], { stage: { _tag: "Verify", check: CheckNumber.make(1) } })
    expect([found.kept[0]?.reasoning, checked.kept[0]?.reasoning, same.kept[0]?.reasoning]).toEqual([undefined, { enabled: false }, undefined])
  })
})

describe("a host's own tools", () => {
  const SIX = ["readLines", "searchCode", "listFiles", "readDiff", "reportFinding", "verdict"]
  const FindDefinition = Tool.make("findDefinition", {
    description: "Find where a name is defined at the commit under review.",
    parameters: Schema.Struct({ name: Schema.String.annotate({ description: "The name, such as sum." }) }),
    success: Schema.String,
    failure: Schema.String,
    failureMode: "return",
  })
  const definitionTools = Toolkit.make(FindDefinition)
  /** A host's tool over what the turn reviews, each name it is asked for kept in `asked`. */
  const definitions = (asked: Array<string>): HostTools<typeof definitionTools.tools> => ({
    toolkit: definitionTools,
    handlers: (reviewed) => definitionTools.toLayer({
      findDefinition: ({ name }) => Effect.sync(() => {
        asked.push(name)
        return `${name} is defined in src/sum.ts at ${reviewed.at}.`
      }),
    }),
  })
  const withDefinitions = (asked: Array<string>) => (model: Layer.Layer<LanguageModel.LanguageModel, never, ModelSpend>) => kernelTurns({ model, hostTools: definitions(asked) })

  /** The tools a request declares when it is sent with `reviewTools` alone, as every request was before host tools. */
  const declaredAlone = async () => {
    const { fetch, kept } = endpoint([says("")])
    await Effect.runPromise(LanguageModel.streamText({ prompt: Prompt.make([{ role: "user", content: "Review it." }]), toolkit: reviewTools, disableToolCallResolution: true, toolCallValidation: "deferred" }).pipe(
      Stream.runDrain,
      Effect.provide(testModel({}).pipe(Layer.provide(modelSpendMemory))),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ))
    return kept[0]?.declared ?? []
  }

  test("with no host tools, every request declares the six as reviewTools alone does, byte for byte and in order", async () => {
    const ran = await turn([asks(["readLines", { path: "src/sum.ts" }]), says("Read."), says("none")])
    const alone = await declaredAlone()
    expect(alone.length).toBe(6)
    expect(ran.kept.map((one) => one.tools)).toEqual([0, 1, 2].map(() => SIX))
    expect(ran.kept.map((one) => one.declared)).toEqual([0, 1, 2].map(() => alone))
  })

  test("a host's tool is offered after the six in every request, and its call runs in a step as the six's do", async () => {
    const asked: Array<string> = []
    const ran = await turn([asks(["findDefinition", { name: "sum" }], ["readLines", { path: "src/sum.ts" }]), says("Read."), says("none")], { turnsOf: withDefinitions(asked) })
    const alone = await declaredAlone()
    expect(asked).toEqual(["sum"])
    expect(ran.kept.map((one) => one.tools)).toEqual([0, 1, 2].map(() => [...SIX, "findDefinition"]))
    expect<unknown>(ran.kept.map((one) => one.declared.slice(0, 6))).toEqual([0, 1, 2].map(() => alone))
    expect(ran.kept[0]?.declared[6]).toContain("Find where a name is defined at the commit under review.")
    expect(JSON.stringify(ran.kept[1]?.messages)).toContain(`sum is defined in src/sum.ts at ${head}.`)
    // Only readLines and readDiff open a file: the host's tool names none.
    expect<unknown>([ran.result.ended, ran.result.opened]).toEqual([{ _tag: "Answered", summary: "Read." }, ["src/sum.ts"]])
  })

  test("a host's tool that fails as data, fails as an error or dies is stored as a failed result, and the turn goes on", async () => {
    const empty = Schema.Struct({})
    const Failing = Tool.make("failing", { description: "Fails as data.", parameters: empty, success: Schema.String, failure: Schema.String, failureMode: "return" })
    const Erroring = Tool.make("erroring", { description: "Fails as an error.", parameters: empty, success: Schema.String, failure: Schema.String })
    const Dying = Tool.make("dying", { description: "Dies.", parameters: empty, success: Schema.String })
    const brokenTools = Toolkit.make(Failing, Erroring, Dying)
    const broken: HostTools<typeof brokenTools.tools> = {
      toolkit: brokenTools,
      handlers: () => brokenTools.toLayer({
        failing: () => Effect.fail("No definition of that name."),
        erroring: () => Effect.fail("The language server is down."),
        dying: () => Effect.die(new Error("The handler broke.")),
      }),
    }
    const ran = await turn([asks(["failing", {}], ["erroring", {}], ["dying", {}]), says("Done."), says("none")], { turnsOf: (model) => kernelTurns({ model, hostTools: broken }) })
    const results = JSON.stringify(ran.kept[1]?.messages.slice(-3))
    expect<unknown>([ran.result.ended, ran.kept.length, ["No definition of that name.", "The language server is down.", "The handler broke."].map((text) => results.includes(text))]).toEqual([
      { _tag: "Answered", summary: "Done." }, 3, [true, true, true],
    ])
  })

  test("what a host's tools add to a request is the bytes the wire sends for their declarations: none, nothing", async () => {
    const offered = (layer: Layer.Layer<ReviewTurns, never, Checkout | Findings>) =>
      Effect.runPromise(Effect.map(ReviewTurns, (turns) => turns.hostTools).pipe(Effect.provide(layer.pipe(Layer.provide(Layer.mergeAll(checkoutLayer, findingsInMemory))))))
    const model = testModel({})
    const none = await offered(kernelTurns({ model }))
    const added = await offered(kernelTurns({ model, hostTools: definitions([]) }))
    const alone = await turn([says("Nothing."), says("none")])
    const withHost = await turn([says("Nothing."), says("none")], { turnsOf: withDefinitions([]) })
    expect<unknown>([none, added.names, (withHost.kept[0]?.bytes ?? 0) - (alone.kept[0]?.bytes ?? 0)]).toEqual([{ names: [], declarationBytes: 0 }, ["findDefinition"], added.declarationBytes])
  })

  test("a closing call runs its reporting calls alone: a host's tool asked for at the step cap or on the harvest does not run", async () => {
    const capped: Array<string> = []
    const atCap = await turn([asks(["findDefinition", { name: "sum" }]), asks(["findDefinition", { name: "total" }], ["reportFinding", FINDING])], { maxSteps: 1, turnsOf: withDefinitions(capped) })
    expect<unknown>([atCap.result.ended._tag, atCap.findings.length, capped, atCap.kept.map((one) => one.tools)]).toEqual(["StepCap", 1, ["sum"], [0, 1].map(() => [...SIX, "findDefinition"])])
    const harvested: Array<string> = []
    const harvest = await turn([says("Done."), asks(["findDefinition", { name: "sum" }], ["reportFinding", FINDING]), says("never sent")], { turnsOf: withDefinitions(harvested) })
    expect<unknown>([harvest.result.ended, harvest.findings.length, harvested, harvest.kept.length]).toEqual([{ _tag: "Answered", summary: "Done." }, 1, [], 2])
  })

  test("type-level: a host's toolkit without its handlers, a handler of the wrong type or a tool named as one of the six does not compile", () => {
    const model = testModel({})
    // A host's tools as they compile: the layer needs what the six need, and nothing more.
    const plain: Layer.Layer<ReviewTurns, never, Checkout | Findings> = kernelTurns({ model, hostTools: definitions([]) })
    // @ts-expect-error: the handlers give no handler of findDefinition
    const missing: HostTools<typeof definitionTools.tools> = { toolkit: definitionTools, handlers: () => Layer.empty }
    // @ts-expect-error: findDefinition answers a string, not a number
    const wrong = definitionTools.toLayer({ findDefinition: ({ name }) => Effect.succeed(name.length) })
    const ReadLinesAgain = Tool.make("readLines", { parameters: Schema.Struct({}), success: Schema.String, failure: Schema.String, failureMode: "return" })
    const clashing = Toolkit.make(ReadLinesAgain)
    // @ts-expect-error: a host's tool cannot take the name of one of the six
    const clash = kernelTurns({ model, hostTools: { toolkit: clashing, handlers: () => clashing.toLayer({ readLines: () => Effect.succeed("") }) } })
    // Tools named at run time: a toolkit keyed by any string may hold one of the six's names.
    const named: string = "findDefinition"
    const anyNamed = Toolkit.make(Tool.make(named, { parameters: Schema.Struct({}), success: Schema.String, failure: Schema.String, failureMode: "return" }))
    // @ts-expect-error: a toolkit keyed by any string is refused, as it may take a name of the six
    const byString = kernelTurns({ model, hostTools: { toolkit: anyNamed, handlers: () => anyNamed.toLayer({}) } })
    expect([Layer.isLayer(plain), typeof missing.handlers, Layer.isLayer(wrong), Layer.isLayer(clash), Layer.isLayer(byString)]).toEqual([true, "function", true, true, true])
  })

  test("type-level: what a host's tool declares is what the turns' layer needs", () => {
    const model = testModel({})
    const FindSession = Tool.make("findSession", { parameters: Schema.Struct({}), success: Schema.String, failure: Schema.String, failureMode: "return", dependencies: [Sessions] })
    const sessionTools = Toolkit.make(FindSession)
    const needing: HostTools<typeof sessionTools.tools> = { toolkit: sessionTools, handlers: () => sessionTools.toLayer({ findSession: () => Effect.succeed("") }) }
    const turns = kernelTurns({ model, hostTools: needing })
    type Needs<L> = L extends Layer.Layer<infer _Out, infer _Error, infer In> ? In : never
    const needsSessions: [Sessions] extends [Needs<typeof turns>] ? true : false = true
    // @ts-expect-error: the layer needs Sessions too, which the host gives
    const short: Layer.Layer<ReviewTurns, never, Checkout | Findings> = turns
    expect([needsSessions, Layer.isLayer(short)]).toEqual([true, true])
  })

  test("in a check, a host's tool is offered after the six and its call runs before the verdict", async () => {
    const VERDICT = { outcome: "refuted", reason: "Multiplying by one is harmless.", quote: "total += value * 1" }
    const asked: Array<string> = []
    const ran = await turn([asks(["findDefinition", { name: "sum" }]), asks(["verdict", VERDICT]), says("never sent")], { stage: { _tag: "Verify", check: CheckNumber.make(1) }, turnsOf: withDefinitions(asked) })
    expect<unknown>([ran.result.ended, ran.verdict, asked, ran.kept.map((one) => one.tools)]).toEqual([{ _tag: "Judged" }, Option.some({ ...VERDICT, check: 1 }), ["sum"], [0, 1].map(() => [...SIX, "findDefinition"])])
  })
})

describe("a turn over the kernel", () => {
  test("the model reads, reports, and answers: the finding recorded, each call's tokens and cost, the files opened, the journal kept", async () => {
    const ran = await turn([asks(["readLines", { path: "src/sum.ts" }], ["reportFinding", FINDING]), says("One bug: a multiplication by one."), says("none")])
    expect<unknown>(ran.result).toEqual({
      stage: { _tag: "Find", turn: 1 },
      session: expect.objectContaining({ _tag: "Some" }),
      ended: { _tag: "Answered", summary: "One bug: a multiplication by one." },
      calls: [
        { step: 1, tokens: Option.some({ input: 1_000, cached: 800, output: 50 }), cost: 0.0004 },
        { step: 2, tokens: Option.some({ input: 1_200, cached: 1_000, output: 20 }), cost: 0.0002 },
        { step: 3, tokens: Option.some({ input: 1_200, cached: 1_000, output: 20 }), cost: 0.0002 },
      ],
      opened: ["src/sum.ts"],
    })
    expect<unknown>(ran.findings).toEqual([{ ...FINDING, turn: 1, number: 1 }])
    expect(Math.round(ran.settled * 1e6) / 1e6).toBe(0.0008)
    // Each request starts with the prefix, unchanged; then the tail, the calls and their results, as the memory gives
    // them; the last, the harvest, after the answer in words and the host's note.
    expect(ran.sent.map((messages) => messages.map((message) => message.role))).toEqual([
      ["system", "user", "user"],
      ["system", "user", "user", "assistant", "tool", "tool"],
      ["system", "user", "user", "assistant", "tool", "tool", "assistant", "user"],
    ])
    expect(ran.sent.map((messages) => messages.slice(0, 3).map((message) => message.content))).toEqual([0, 1, 2].map(() => ["The system text.", "The pull request.", "Review it."]))
    expect(ran.journal.length).toBeGreaterThan(0)
  })

  test("the step cap ends a turn that keeps asking, with the findings so far, after one more call", async () => {
    const ran = await turn([asks(["reportFinding", FINDING]), asks(["listFiles", { glob: "src/*" }])], { maxSteps: 3 })
    expect([ran.result.ended, ran.result.calls.length, ran.findings.length, ran.sent.length]).toEqual([{ _tag: "StepCap", steps: 3, summary: "", why: "" }, 4, 1, 4])
  })

  test("a closing call that fails is said: the step cap with why", async () => {
    const ran = await turn([asks(["listFiles", { glob: "src/*" }]), { status: 400, body: JSON.stringify({ error: { message: "the model does not exist" } }) }], { maxSteps: 1 })
    expect([ran.result.ended._tag, ran.result.ended._tag === "StepCap" && ran.result.ended.why.includes("the model does not exist")]).toEqual(["StepCap", true])
  })

  test("onFirstAnswer through the real loop: once, after the first call returns, true when it answered; false when it failed, or when the turn ended before any call", async () => {
    const answered = await turn([asks(["listFiles", { glob: "src/*" }]), says("Done.")])
    const refused = await turn([says("never sent")], { maxCost: 0.000_01 })
    const broken = await turn([says("never sent")], { turns: { journal: () => Layer.effect(JournalStorage, Effect.fail(new TurnJournalFailed({ message: "the disk is full" }))) } })
    expect([answered.signals, refused.signals, broken.signals]).toEqual([[[true, 1]], [[false, 0]], [[false, 0]]])
  })

  test("the first call the other turns wait on is asked once more after a failure worth another try; a refusal, a second failure and a turn no one waits on are not", async () => {
    const unavailable = { status: 503, body: JSON.stringify({ error: { message: "the provider is overloaded" } }) }
    const refusedCall = { status: 400, body: JSON.stringify({ error: { message: "the model does not exist" } }) }
    const limited = { status: 429, body: JSON.stringify({ error: { message: "slow down" } }) }
    // A turn that answers asks once more for what it weighed (the harvest), answered "none" here.
    const blip = await turn([unavailable, says("Done."), says("none")])
    const rateLimited = await turn([limited, says("Done."), says("none")])
    const twice = await turn([unavailable, unavailable, says("Done.")])
    const refused = await turn([refusedCall, says("Done.")])
    const alone = await turn([unavailable, says("Done.")], { waitedOn: false })
    expect([blip.result.ended, blip.signals, blip.sent.length, blip.result.calls.map((call) => [call.step, Option.isSome(call.tokens)])]).toEqual([{ _tag: "Answered", summary: "Done." }, [[true, 2]], 3, [[1, false], [1, true], [2, true]]])
    expect([rateLimited.result.ended._tag, rateLimited.sent.length]).toEqual(["Answered", 3])
    expect([twice.result.ended._tag, twice.signals, twice.sent.length]).toEqual(["ModelFailed", [[false, 2]], 2])
    expect([refused.result.ended._tag, refused.signals, refused.sent.length]).toEqual(["ModelFailed", [[false, 1]], 1])
    expect([alone.result.ended._tag, alone.sent.length]).toEqual(["ModelFailed", 1])
  })

  test("a focused group's turn (retryFirstCall, no one waiting) asks its first call once more after a 503, and not after a 400", async () => {
    const unavailable = { status: 503, body: JSON.stringify({ error: { message: "the provider is overloaded" } }) }
    const refusedCall = { status: 400, body: JSON.stringify({ error: { message: "the model does not exist" } }) }
    const blip = await turn([unavailable, says("Done."), says("none")], { waitedOn: false, retryFirstCall: true })
    const refused = await turn([refusedCall, says("Done.")], { waitedOn: false, retryFirstCall: true })
    expect([blip.result.ended._tag, blip.sent.length, refused.result.ended._tag, refused.sent.length]).toEqual(["Answered", 3, "ModelFailed", 1])
  })

  test("firstCallBytes counts at least the first request's body the ledger holds on, for a newline- and quote-heavy prompt", async () => {
    const prompt = { prefix: [{ role: "system" as const, content: "The system text." }, { role: "user" as const, content: `${"a line\n".repeat(4_000)}${"\"q\" ".repeat(2_000)}` }], tail: "Review it." }
    const ran = await turn([says("Done.")], { prompt, waitedOn: false })
    const sent = ran.kept[0]?.bytes ?? 0
    // Within the slack it keeps for the tools: never under the body, and not far over it.
    expect([sent > 40_000, firstCallBytes(prompt) >= sent, firstCallBytes(prompt) - sent < REQUEST_SLACK_BYTES]).toEqual([true, true, true])
  })

  test("a spend refusal mid-turn, with a reserve kept back from the start: the reserve released, the host's note, and the closing call's finding kept", async () => {
    // Each call holds $0.004096 (4,096 tokens of output at $1 a million) and is billed $0.0004. With $0.0045 kept back
    // under a cap of $0.0089, the first call fits and the second does not; released, the reserve makes room to close.
    const closingAnswer = asks(["reportFinding", FINDING])
    const price = { input: 0, output: 1, cacheRead: 0 }
    const kept = await turn([asks(["listFiles", { glob: "src/*" }]), closingAnswer], { maxCost: 0.0089, price, reserve: 0.0045 })
    const none = await turn([asks(["listFiles", { glob: "src/*" }]), closingAnswer], { maxCost: 0.0089 - 0.0045, price })
    expect([kept.result.ended._tag, kept.findings.length, kept.kept.length, none.result.ended._tag, none.findings.length, none.kept.length]).toEqual(["SpendRefused", 1, 2, "SpendRefused", 0, 1])
    expect(kept.kept.at(-1)?.messages.at(-1)).toEqual({ role: "user", content: "[Host note: You have used the tool calls this review allows. Report now with reportFinding each problem you found and have not reported, then answer with a one-line summary. No other tool runs now.]" })
  })

  test("a closing call after a spend refusal that fails is said beside the refusal", async () => {
    const price = { input: 0, output: 1, cacheRead: 0 }
    const ran = await turn([asks(["listFiles", { glob: "src/*" }]), { status: 400, body: JSON.stringify({ error: { message: "the model does not exist" } }) }], { maxCost: 0.0089, price, reserve: 0.0045 })
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
    const ran = await turn([asks(["listFiles", { glob: "src/*" }]), asks(["listFiles", { glob: "*" }]), lastAnswer], { maxSteps: 2 })
    expect<unknown>([ran.result.ended, ran.findings.length, ran.result.opened, ran.kept.length]).toEqual([{ _tag: "StepCap", steps: 2, summary: "One more problem.", why: "" }, 1, [], 3])
    expect(ran.kept.at(-1)?.messages.at(-1)).toEqual({ role: "user", content: "[Host note: You have used the tool calls this review allows. Report now with reportFinding each problem you found and have not reported, then answer with a one-line summary. No other tool runs now.]" })
    expect(ran.kept.map((one) => one.tools)).toEqual([0, 1, 2].map(() => ["readLines", "searchCode", "listFiles", "readDiff", "reportFinding", "verdict"]))
  })

  test("a check ends once its verdict is recorded; reportFinding is refused in a check", async () => {
    const VERDICT = { outcome: "confirmed", reason: "It multiplies by one.", quote: "total += value * 1" }
    const ran = await turn([asks(["reportFinding", FINDING]), asks(["verdict", VERDICT]), says("never sent")], { stage: { _tag: "Verify", check: CheckNumber.make(1) } })
    expect<unknown>([ran.result.ended, ran.findings, ran.verdict, ran.kept.length]).toEqual([{ _tag: "Judged" }, [], Option.some({ ...VERDICT, check: 1 }), 2])
    expect(JSON.stringify(ran.kept[1]?.messages.at(-1))).toContain("You are checking a finding, not reporting new ones: call verdict with your verdict on it.")
  })

  test("a check that answers in words is asked once more for its verdict: the host's note, the same tools offered; a verdict in text is never one; a turn is asked once more for reportFinding alone", async () => {
    const VERDICT = { outcome: "confirmed", reason: "It multiplies by one.", quote: "total += value * 1" }
    const check = { stage: { _tag: "Verify", check: CheckNumber.make(1) } } as const
    const judged = await turn([says("Verdict: confirmed."), asks(["verdict", VERDICT]), says("never sent")], check)
    const words = await turn([says("Verdict: confirmed."), says("Verdict: confirmed, again."), says("never sent")], check)
    expect<unknown>([judged.result.ended, judged.verdict, judged.kept.length]).toEqual([{ _tag: "Judged" }, Option.some({ ...VERDICT, check: 1 }), 2])
    expect(judged.kept.at(-1)?.messages.at(-1)).toEqual({ role: "user", content: "[Host note: This check ends now. Call verdict now with your outcome, your reason and a quote of the cited lines your verdict rests on: a verdict written as text is not counted. No other tool runs now.]" })
    expect(judged.kept.map((one) => one.tools)).toEqual([0, 1].map(() => ["readLines", "searchCode", "listFiles", "readDiff", "reportFinding", "verdict"]))
    expect<unknown>([words.result.ended, words.verdict, words.kept.length]).toEqual([{ _tag: "Answered", summary: "Verdict: confirmed." }, Option.none(), 2])
    // A turn that answers in words is asked once more (the harvest), and only that answer's reportFinding calls run:
    // its readLines is not, so nothing is opened; it has answered, with its first words.
    const answered = await turn([says("Done."), asks(["readLines", { path: "src/sum.ts" }], ["reportFinding", FINDING]), says("never sent")])
    expect<unknown>([answered.result.ended, answered.findings.length, answered.result.opened, answered.kept.length]).toEqual([{ _tag: "Answered", summary: "Done." }, 1, [], 2])
  })

  test("a check refused mid-way with a reserve kept back gives its verdict on the closing call and is judged", async () => {
    const VERDICT = { outcome: "refuted", reason: "Multiplying by one is harmless.", quote: "total += value * 1" }
    const price = { input: 0, output: 1, cacheRead: 0 }
    const ran = await turn([asks(["listFiles", { glob: "src/*" }]), asks(["verdict", VERDICT])], { maxCost: 0.0089, price, reserve: 0.0045, stage: { _tag: "Verify", check: CheckNumber.make(1) } })
    expect<unknown>([ran.result.ended, ran.verdict, ran.kept.length]).toEqual([{ _tag: "Judged" }, Option.some({ ...VERDICT, check: 1 }), 2])
  })

  test("a turn refuses verdict: there is no finding to check", async () => {
    const ran = await turn([asks(["verdict", { outcome: "refuted", reason: "r", quote: "q" }]), says("Done.")])
    expect<unknown>([ran.result.ended, ran.verdict]).toEqual([{ _tag: "Answered", summary: "Done." }, Option.none()])
    expect(JSON.stringify(ran.kept[1]?.messages.at(-1))).toContain("There is no finding to check in this review: report each problem with reportFinding.")
  })

  test("the spend cap refuses a call before it is sent: the turn ends, incomplete, with nothing spent", async () => {
    const ran = await turn([says("never sent")], { maxCost: 0.000_01 })
    expect([ran.result.ended._tag, ran.result.calls, ran.sent.length, ran.settled]).toEqual(["SpendRefused", [{ step: 1, tokens: Option.none(), cost: 0 }], 0, 0])
  })

  test("an answer cut at the output cap ends the turn, incomplete, after its findings", async () => {
    const ran = await turn([asks(["reportFinding", FINDING]), says("The second finding is", "length")])
    expect([ran.result.ended, ran.result.calls.length, ran.findings.length]).toEqual([{ _tag: "OutputCut" }, 2, 1])
  })

  test("an answer cut at the output cap still runs the calls it asked for whole: its finding is kept", async () => {
    const ran = await turn([asksEnding("length", [["reportFinding", FINDING]])])
    expect([ran.result.ended, ran.result.calls.length, ran.findings.length, ran.sent.length]).toEqual([{ _tag: "OutputCut" }, 1, 1, 1])
  })

  test("a spend refusal mid-turn keeps the findings and the cost of the calls before it", async () => {
    // Each call holds its 4,096 tokens of output at $1 a million (nothing for input): $0.004096. The first fits under
    // $0.0044 and is billed $0.0004; the second would take the ledger to $0.004496, and is refused before it is sent.
    const ran = await turn([asks(["reportFinding", FINDING]), says("never sent")], { maxCost: 0.0044, price: { input: 0, output: 1, cacheRead: 0 } })
    expect<unknown>([ran.result.ended._tag, ran.result.calls, ran.findings.length, ran.sent.length, Math.round(ran.settled * 1e6) / 1e6]).toEqual([
      "SpendRefused", [{ step: 1, tokens: Option.some({ input: 1_000, cached: 800, output: 50 }), cost: 0.0004 }, { step: 2, tokens: Option.none(), cost: 0 }], 1, 1, 0.0004,
    ])
  })

  test("a call the provider refuses ends the turn, incomplete, in the provider's words", async () => {
    const ran = await turn([{ status: 400, body: JSON.stringify({ error: { message: "the model does not exist" } }) }])
    expect([ran.result.ended._tag, ran.result.ended._tag === "ModelFailed" && ran.result.ended.message.includes("the model does not exist"), ran.result.calls.length]).toEqual(["ModelFailed", true, 1])
  })

  test("a journal that cannot be opened ends the turn, incomplete, in words, with no session and no call", async () => {
    const broken: Omit<KernelTurnsOptions, "model"> = { journal: () => Layer.effect(JournalStorage, Effect.fail(new TurnJournalFailed({ message: "the disk is full" }))) }
    const ran = await turn([says("never sent")], { turns: broken })
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
    const ran = await turn([asks(["listFiles", { glob: "*" }]), says("Nothing."), says("none")], { turns: { memory } })
    expect([asked, ran.result.ended._tag, ran.sent.length]).toEqual([3, "Answered", 3])
  })
})

describe("the closing call asked once more after a refused report", () => {
  const ELSEWHERE = { ...FINDING, path: "src/never-changed.ts" }

  test("a step-cap closing call whose reportFinding the tool refuses (a path the pull request does not change) is asked once more, and its second, valid report is recorded", async () => {
    const ran = await turn([asks(["listFiles", { glob: "src/*" }]), asks(["reportFinding", ELSEWHERE]), asks(["reportFinding", FINDING]), says("never sent")], { maxSteps: 1 })
    expect<unknown>([ran.result.ended, ran.findings, ran.kept.length]).toEqual([{ _tag: "StepCap", steps: 1, summary: "", why: "" }, [{ ...FINDING, turn: 1, number: 1 }], 3])
    // The second ask reads the refusal, which says what to give, with the same six tools offered.
    const refusal = ran.kept[2]?.messages.at(-1)
    expect([refusal?.role, JSON.stringify(refusal?.content).includes("src/never-changed.ts is not a file this pull request changes")]).toEqual(["tool", true])
    expect(ran.kept.map((one) => one.tools)).toEqual([0, 1, 2].map(() => ["readLines", "searchCode", "listFiles", "readDiff", "reportFinding", "verdict"]))
  })

  test("a second refusal ends the closing: no third call, whatever it would have reported", async () => {
    const ran = await turn([asks(["listFiles", { glob: "src/*" }]), asks(["reportFinding", ELSEWHERE]), asks(["reportFinding", ELSEWHERE]), asks(["reportFinding", FINDING])], { maxSteps: 1 })
    expect<unknown>([ran.result.ended, ran.findings, ran.kept.length]).toEqual([{ _tag: "StepCap", steps: 1, summary: "", why: "" }, [], 3])
  })
})

describe("the harvest: a turn that answers in words is asked once more for what it weighed", () => {
  const HARVEST = "[Host note: Before this pass ends: call reportFinding now for each possible defect you noticed or weighed in the files you reviewed and did not report, also one you judged too small or not sure, saying in its claim what would make it real; another reviewer checks each report. If there is none, answer \"none\". No other tool runs now.]"

  test("a turn that answers in words, then reports on the harvest, keeps that finding: the host's note, the same six tools, only reportFinding run, the first answer's summary", async () => {
    const harvested = sse([
      { choices: [{ delta: { content: "One I had kept back.", tool_calls: [
        { index: 0, id: "c0", type: "function", function: { name: "readLines", arguments: JSON.stringify({ path: "src/sum.ts" }) } },
        { index: 1, id: "c1", type: "function", function: { name: "reportFinding", arguments: JSON.stringify(FINDING) } },
      ] }, finish_reason: "tool_calls" }] },
      usage(1_000, 800, 50, 0.0004),
    ])
    const ran = await turn([says("Nothing wrong."), harvested, says("never sent")])
    expect<unknown>([ran.result.ended, ran.findings, ran.result.opened, ran.kept.length, ran.result.calls.map((call) => call.step)]).toEqual([
      { _tag: "Answered", summary: "Nothing wrong." }, [{ ...FINDING, turn: 1, number: 1 }], [], 2, [1, 2],
    ])
    expect(ran.kept.at(-1)?.messages.at(-1)).toEqual({ role: "user", content: HARVEST })
    expect(ran.kept.map((one) => one.tools)).toEqual([0, 1].map(() => ["readLines", "searchCode", "listFiles", "readDiff", "reportFinding", "verdict"]))
  })

  test("one whose harvest answers none ends Answered with the first summary; one whose harvest call fails too", async () => {
    const none = await turn([says("Nothing wrong."), says("none"), says("never sent")])
    const failed = await turn([says("Nothing wrong."), { status: 400, body: JSON.stringify({ error: { message: "the model does not exist" } }) }])
    expect<unknown>([none.result.ended, none.findings, none.kept.length, none.kept.at(-1)?.messages.at(-1)]).toEqual([{ _tag: "Answered", summary: "Nothing wrong." }, [], 2, { role: "user", content: HARVEST }])
    expect<unknown>([failed.result.ended, failed.kept.length]).toEqual([{ _tag: "Answered", summary: "Nothing wrong." }, 2])
  })

  test("a check that answers in words is never harvested: its closing note asks for the verdict", async () => {
    const ran = await turn([says("Verdict: confirmed."), says("Still confirmed.")], { stage: { _tag: "Verify", check: CheckNumber.make(1) } })
    expect(ran.kept.at(-1)?.messages.at(-1)).toEqual({ role: "user", content: "[Host note: This check ends now. Call verdict now with your outcome, your reason and a quote of the cited lines your verdict rests on: a verdict written as text is not counted. No other tool runs now.]" })
  })
})

describe("three turns at once under the review's budget", () => {
  // A request of 700 KB, over twice the longest live single turn's last (about 300 KB), held at 1 byte a token at $0.30
  // a million ($0.21) plus 4,096 tokens of output at $1.20 a million: about $0.216 a call, so three calls' holds ($0.65)
  // pass the find stage's $0.50 and the turns' calls crowd each other out. Each call is billed $0.0025, so a turn's
  // seventeen calls (sixteen, then the harvest) settle $0.0425.
  const PREFIX = [{ role: "system" as const, content: "The system text." }, { role: "user" as const, content: "x".repeat(700_000) }]
  const billed = (answer: string) => answer.replace(/"cost":[0-9.]+/, "\"cost\":0.0025")
  /**
   * An endpoint for several turns at once: each request answered by how far its own conversation is, a call for its
   * first `calls` steps, then words. With `lockstep`, the requests go in rounds of `lockstep`: each waits until its
   * round is full (or `LOCKSTEP_FALLBACK_MS` passed, which only frees the turns left once one has ended), so every
   * turn's call of a round is open at once, whatever the scheduler does.
   */
  const steady = (calls = 15, lockstep = 0) => {
    let arrived = 0
    // Once a round has waited past the fallback, a turn has ended: the rounds are over and no request waits again.
    let freed = false
    const waiting: Array<{ readonly until: number; readonly go: () => void }> = []
    return Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const asked = sentOf(JSON.parse(await new Response(init?.body ?? "").text())).messages.filter((message) => message.role === "assistant").length
      if (lockstep > 0 && !freed) {
        const until = (Math.floor(arrived / lockstep) + 1) * lockstep
        arrived += 1
        for (const one of waiting.filter((entry) => entry.until <= arrived)) one.go()
        if (until > arrived) await new Promise<void>((go) => {
          waiting.push({ until, go })
          setTimeout(() => {
            freed = true
            for (const one of waiting) one.go()
          }, LOCKSTEP_FALLBACK_MS)
        })
      }
      return new Response(billed(asked < calls ? asks(["listFiles", { glob: "src/*" }]) : says("Done.")), { status: 200, headers: { "content-type": "text/event-stream" } })
    }, { preconnect: () => {} })
  }
  const LOCKSTEP_FALLBACK_MS = 2_000

  /**
   * A stage whose calls wait until `count` turns have kept their reserve back, so every reserve is held before any
   * call is asked, whatever order the turns start in.
   */
  const keptFirst = (stage: StageLedger, count: number): Effect.Effect<StageLedger> => Effect.map(Deferred.make<void>(), (allKept) => {
    let kept = 0
    return {
      ...stage,
      keepBack: (amount: number) => Effect.tap(stage.keepBack(amount), () => Effect.suspend(() => {
        kept += 1
        return kept >= count ? Deferred.succeed(allKept, undefined) : Effect.void
      })),
      reserve: (request) => Effect.flatMap(Deferred.await(allKept), () => stage.reserve(request)),
    }
  })

  /**
   * `count` turns at once on `spend(root)`, the review's ledger capped at the default total, each keeping `reserve` back
   * and capped at `maxSteps`, on the `endpoint`: how each ended and what was settled.
   */
  const turnsAtOnce = (spend: (root: Context.Service.Shape<typeof ModelSpend>) => Effect.Effect<StageLedger>, count = 3, reserve = 0, endpoint = steady(), maxSteps = 16) => {
    const layers = kernelTurns({ model: testModel({ maxCost: DEFAULT_MAX_COST }) }).pipe(Layer.provideMerge(Layer.mergeAll(checkoutLayer, findingsInMemory, modelSpendMemory)))
    const folder = mkdtempSync(join(fixture.root, "three-"))
    return Effect.runPromise(Effect.gen(function* () {
      const root = yield* ModelSpend
      const stage = yield* spend(root)
      const turns = yield* ReviewTurns
      const results = yield* Effect.forEach(Array.from({ length: count }, (_, index) => index + 1), (number) => turns.run({
        prompt: { prefix: PREFIX, tail: "Review it." },
        reviewed: { run: "run-1", repo, at: head, files, stage: { _tag: "Find", turn: TurnNumber.make(number) } },
        journalAt: join(folder, `turn-${number}`),
        options: { maxSteps, reserve },
        spend: stage,
      }), { concurrency: "unbounded" })
      return { ended: results.map((result) => result.ended._tag), settled: Math.round((yield* root.totals).settled * 1e6) / 1e6, held: (yield* root.totals).reserved }
    }).pipe(Effect.provide(layers), Effect.provideService(FetchHttpClient.Fetch, endpoint)))
  }
  const defaultStages = (root: Context.Service.Shape<typeof ModelSpend>) => Effect.flatMap(stageSpend(root, Option.some(DEFAULT_BUDGET.total)), (total) => stageSpend(total, Option.some(DEFAULT_BUDGET.find)))

  test("under the default budget's find stage, none ends on a spend refusal: a call the others' holds crowd out waits", async () => {
    const ran = await turnsAtOnce(defaultStages)
    expect(ran).toEqual({ ended: ["Answered", "Answered", "Answered"], settled: 0.1275, held: 0 })
  }, 60_000)

  test("why turns beside each other keep nothing back: three each keeping a sixth of the find stage crowd out each other's calls and end refused", async () => {
    // Every reserve is held before any call (`keptFirst`), and no turn gives its sixth back (its harvest's closing call)
    // before it has made 24 calls. Three sixths ($0.25) and one call's hold (about $0.216) leave the find stage's $0.50
    // room for about $0.034 settled, fourteen calls at most: whatever the interleaving, a call is refused first.
    const ran = await turnsAtOnce((root) => Effect.flatMap(defaultStages(root), (stage) => keptFirst(stage, 3)), 3, DEFAULT_BUDGET.find / 6, steady(23), 24)
    expect([ran.ended.includes("SpendRefused"), ran.held]).toEqual([true, 0])
  }, 60_000)

  test("one turn keeping the default closing reserve back answers under the default budget, and its reserve is released", async () => {
    const ran = await turnsAtOnce(defaultStages, 1, DEFAULT_CLOSING_RESERVE)
    expect(ran).toEqual({ ended: ["Answered"], settled: 0.0425, held: 0 })
  }, 60_000)

  test("control: on the same cap, a ledger that refuses whatever open holds crowd out ends a turn on a refusal", async () => {
    // In lockstep, the three calls of a round are open at once: two holds of about $0.216 fit under $0.50 and the
    // third is refused, where the stage's ledger makes it wait.
    const ran = await turnsAtOnce((root) => Effect.succeed({ ...ModelSpend.of({ ...root, reserve: (request) => root.reserve({ ...request, caps: { total: DEFAULT_BUDGET.find } }) }), keepBack: () => Effect.succeed(Option.none()) }), 3, 0, steady(15, 3))
    expect(ran.ended).toContain("SpendRefused")
  }, 60_000)
})

describe("a turn's read limit", () => {
  const read = ["readLines", { path: "src/sum.ts" }] as const
  /** The tool messages of a request, each as its content's text. */
  const resultsSent = (sent: ReadonlyArray<Sent>, at: number) => (sent[at]?.messages ?? []).filter((message) => message.role === "tool").map((message) => JSON.stringify(message.content))

  test("past the limit a read is answered in fixed words without running, and the report still runs; with none, every call runs", async () => {
    // The answer's request and output are 1,050 tokens: the first read runs, its result takes the estimate past 1,100.
    const limited = await turn([asks(read, read, ["reportFinding", FINDING]), says("One.")], { turns: { readTokens: 1_100 } })
    const free = await turn([asks(read, read, ["reportFinding", FINDING]), says("One.")])
    const refused = resultsSent(limited.kept, 1)
    expect([refused.length, refused[0]?.includes("lines 1 to"), refused[1], limited.findings.length]).toEqual([3, true, JSON.stringify(CONTEXT_FULL), 1])
    expect([resultsSent(free.kept, 1).filter((text) => text.includes("lines 1 to")).length, free.findings.length]).toEqual([2, 1])
  })

  test("the words a call past the limit gets", () => {
    expect(CONTEXT_FULL).toBe("Not run: this turn has read as much as one request can hold. Report each defect you found with reportFinding now, then answer with a one-line summary.")
  })
})

describe("a turn over the Messages wire", () => {
  /** A Messages stream, as the gateway sends one: a thinking block's start with no `signature` key. */
  const messagesSse = (blocks: ReadonlyArray<Record<string, unknown>>, stop: string) => [
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 1000 } } },
    ...blocks.flatMap((block, index) => Match.value(block["type"]).pipe(
      Match.when("thinking", () => [
        { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index, delta: { type: "signature_delta", signature: String(block["signature"]) } },
      ]),
      Match.when("tool_use", () => [
        { type: "content_block_start", index, content_block: { type: "tool_use", id: String(block["id"]), name: String(block["name"]), input: {} } },
        { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block["input"]) } },
      ]),
      Match.orElse(() => [
        { type: "content_block_start", index, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index, delta: { type: "text_delta", text: String(block["text"]) } },
      ]),
      (events) => [...events, { type: "content_block_stop", index }],
    )),
    { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 30 } },
    { type: "message_stop" },
  ].map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("")
  const reads = messagesSse([{ type: "thinking", signature: "sig-1" }, { type: "tool_use", id: "toolu_1", name: "readLines", input: { path: "src/sum.ts" } }], "tool_use")
  const answers = messagesSse([{ type: "text", text: "Nothing to report." }], "end_turn")
  const model = (effort: "high" | undefined) => anthropicModel({
    model: "claude-test", apiKey: Redacted.make("test-key"), baseUrl: "https://anthropic.test", maxOutputTokens: 1000, ...(effort === undefined ? {} : { effort }),
    spend: { prices: { "claude-test": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 } }, caps: { total: 0.05 } },
  })
  /** The assistant messages a request sent, each as its content. */
  const answersSent = (sent: ReadonlyArray<Sent>, at: number) => (sent[at]?.messages ?? []).filter((message) => message.role === "assistant").map((message) => message.content)

  test("the thinking an answer signed is sent back at its start in the turn's later requests; replay off sends none", async () => {
    const on = await turn([reads, answers, answers], { turnsOf: () => kernelTurns({ model: model("high") }) })
    const off = await turn([reads, answers, answers], { turnsOf: () => kernelTurns({ model: model("high"), replayThinking: false }) })
    const call = { type: "tool_use", id: "toolu_1", name: "readLines", input: { path: "src/sum.ts" } }
    expect([on.result.ended._tag, on.kept.length, answersSent(on.kept, 1), answersSent(on.kept, 2)[0]]).toEqual([
      "Answered", 3, [[{ type: "thinking", thinking: "", signature: "sig-1" }, call]], [{ type: "thinking", thinking: "", signature: "sig-1" }, call],
    ])
    expect([off.result.ended._tag, answersSent(off.kept, 1)]).toEqual(["Answered", [[call]]])
  })

  test("an answer with no signed thinking is sent as it was; no effort, no thinking asked for", async () => {
    const plain = messagesSse([{ type: "tool_use", id: "toolu_1", name: "readLines", input: { path: "src/sum.ts" } }], "tool_use")
    const ran = await turn([plain, answers, answers], { turnsOf: () => kernelTurns({ model: model(undefined) }) })
    expect([ran.result.ended._tag, answersSent(ran.kept, 1), ran.kept[0]?.thinking]).toEqual(["Answered", [[{ type: "tool_use", id: "toolu_1", name: "readLines", input: { path: "src/sum.ts" } }]], undefined])
  })

  test("the Haiku model on the Messages wire: an effort is adaptive thinking at it; default and none ask for none", async () => {
    const haiku = { ...HAIKU_REVIEW_MODEL, baseUrl: "https://anthropic.test" }
    const at = (effort: Effort) => turn([answers, answers], { turnsOf: () => kernelTurns({ model: reviewModel(withEffort(haiku, effort), Redacted.make("test-key"), 0.05) }) })
    const [high, none, plain] = [await at("high"), await at("none"), await at("default")]
    expect([high.kept[0]?.thinking, high.kept[0]?.reasoning, none.kept[0]?.thinking, plain.kept[0]?.thinking]).toEqual([
      [{ type: "adaptive" }, { effort: "high" }], undefined, undefined, undefined,
    ])
  })
})
