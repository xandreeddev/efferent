// The OpenAI-compatible provider over a fake `fetch` that answers as the gateway's chat-completions stream did on
// 2026-11-16 (DeepSeek V4.1 Flash on Baseten): reasoning deltas, a call's arguments in pieces, two calls by index,
// the usage and the billed cost in the last chunk. No network.
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Redacted, Schema, Stream, Tracer } from "effect"
import { AiError, LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import { kernel, ModelSpend, modelSpendMemory, Sessions, userMessage } from "@xandreed/core/kernel"
import { callTool, flatMemory, inProcessJournal, Memory, modelAnswer, sessions } from "../../index.js"
import { isSpendRefusal } from "../model-spend/model-spend.entity.functions.js"
import type { SpendOptions } from "../model-spend/model-spend.entity.js"
import { openAiCompatibleModel } from "./openai-compatible.adapter.js"
import type { OpenAiCompatibleOptions } from "./openai-compatible.entity.js"

const MODEL = "deepseek/deepseek-v4.1-flash-1017"
const BASE = "https://gateway.test/v1"
const price = { input: 1, output: 4, cacheRead: 0.25 }

const sse = (chunks: ReadonlyArray<unknown>, done = true) => `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}${done ? "data: [DONE]\n\n" : ""}`
const delta = (d: unknown, finish: string | null = null) => ({ choices: [{ delta: d, finish_reason: finish }] })
const usage = { prompt_tokens: 411, completion_tokens: 81, cost: "0.0002205", prompt_tokens_details: { cached_tokens: 256 }, completion_tokens_details: { reasoning_tokens: 11 } }
const words = sse([delta({ role: "assistant", content: "", reasoning: "Twelve threes." }), delta({ content: "12 × 3" }), delta({ content: " = 36." }, "stop"), { choices: [], usage }])
const twoCalls = sse([
  delta({ role: "assistant", reasoning: "We need two sums." }),
  delta({ tool_calls: [{ index: 0, id: "call-a", type: "function", function: { name: "add", arguments: "" } }] }),
  delta({ tool_calls: [{ index: 0, function: { arguments: "{\"a\": 2, \"b\": 3}" } }] }),
  delta({ tool_calls: [{ index: 1, id: "call-b", type: "function", function: { name: "add", arguments: "{\"a\": 4," } }] }),
  delta({ tool_calls: [{ index: 1, function: { arguments: " \"b\": 5}" } }] }, "tool_calls"),
  { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } },
])

interface Sent { readonly url: string; readonly headers: Headers; readonly body: Record<string, unknown> }
type Answer = (sent: Sent, signal: AbortSignal) => Response | Promise<Response>

/** A `fetch` that answers each request with `answer` and keeps what it was sent. */
const fakeFetch = (answer: Answer) => {
  const sent: Array<Sent> = []
  const fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const text = await new Response(init?.body ?? "").text()
    const one: Sent = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(text) }
    sent.push(one)
    return answer(one, init?.signal ?? new AbortController().signal)
  }, { preconnect: () => {} })
  return { fetch, sent }
}
const stream = (body: string, status = 200) => () => new Response(body, { status, headers: { "content-type": "text/event-stream" } })

const options = (spend: SpendOptions, more: Partial<OpenAiCompatibleOptions> = {}, bounded = true): OpenAiCompatibleOptions => ({
  model: MODEL, baseUrl: BASE, apiKey: Redacted.make("test-key"), ...(bounded ? { maxOutputTokens: 1000 } : {}), spend, ...more,
})
const priced: SpendOptions = { prices: { [MODEL]: price } }

const Add = Tool.make("add", { description: "Add two numbers.", parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }), success: Schema.Number })
const tools = Toolkit.make(Add)
const prompt = Prompt.make([{ role: "system", content: "Use a tool when it helps." }, { role: "user", content: [{ type: "text", text: "What is 12 * 3?" }] }])

/** Run `body` over the provider and a fresh ledger, with `fetch` as the transport; give its outcome and the ledger's totals. */
const over = <A, E>(fetch: ReturnType<typeof fakeFetch>["fetch"], provider: OpenAiCompatibleOptions, body: Effect.Effect<A, E, LanguageModel.LanguageModel | ModelSpend>) =>
  Effect.runPromise(Effect.gen(function* () {
    const outcome = yield* Effect.result(body)
    return { outcome, totals: yield* (yield* ModelSpend).totals }
  }).pipe(Effect.provide(openAiCompatibleModel(provider).pipe(Layer.provideMerge(modelSpendMemory))), Effect.provideService(FetchHttpClient.Fetch, fetch)))

const streamed = LanguageModel.streamText({ prompt, toolkit: tools, disableToolCallResolution: true }).pipe(Stream.runCollect)

/** The failure a call ended with: its reason's tag, whether it is worth another try. */
const failureOf = (outcome: { readonly _tag: string; readonly failure?: unknown }) =>
  outcome._tag === "Failure" && AiError.isAiError(outcome.failure) ? [outcome.failure.reason._tag, outcome.failure.isRetryable] : ["none"]

describe("the OpenAI-compatible provider", () => {
  test("streams an answer as text, named for the model; the key goes in a header alone; settled at what the gateway billed", async () => {
    const { fetch, sent } = fakeFetch(stream(words))
    const run = await over(fetch, options(priced, { extra: { providerOptions: { gateway: { order: ["baseten"] } } } }), streamed)
    const parts = run.outcome._tag === "Success" ? run.outcome.success : []
    expect(parts.map((part) => part.type)).toEqual(["response-metadata", "text-start", "text-delta", "text-delta", "text-end", "finish"])
    expect(parts[0]).toMatchObject({ modelId: MODEL })
    expect(parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : [])).join("")).toBe("12 × 3 = 36.")
    expect(sent.map((one) => [one.url, one.headers.get("authorization")])).toEqual([[`${BASE}/chat/completions`, "Bearer test-key"]])
    expect(JSON.stringify(sent[0]!.body)).not.toContain("test-key")
    const body = sent[0]!.body
    expect([body["model"], body["stream"], body["max_tokens"], body["providerOptions"], body["stream_options"]]).toEqual([MODEL, true, 1000, { gateway: { order: ["baseten"] } }, { include_usage: true }])
    expect(run.totals).toEqual({ settled: 0.0002205, reserved: 0 })
  })

  test("sends the tools and the conversation by the wire's ids, and hands on two calls in one answer whole, in the order asked", async () => {
    const { fetch, sent } = fakeFetch(stream(twoCalls))
    const history = Prompt.make([
      { role: "user", content: [{ type: "text", text: "Add 2 and 3." }] },
      { role: "assistant", content: [{ type: "tool-call", id: "call-1", name: "add", params: { a: 2, b: 3 }, providerExecuted: false }] },
      { role: "tool", content: [{ type: "tool-result", id: "call-1", name: "add", isFailure: false, result: 5, providerExecuted: false }] },
    ])
    const run = await over(fetch, options(priced), LanguageModel.streamText({ prompt: history, toolkit: tools, disableToolCallResolution: true }).pipe(Stream.runCollect))
    const parts = run.outcome._tag === "Success" ? run.outcome.success : []
    expect(parts.flatMap((part) => (part.type === "tool-call" ? [[part.id, part.name, part.params]] : []))).toEqual([["call-a", "add", { a: 2, b: 3 }], ["call-b", "add", { a: 4, b: 5 }]])
    expect(parts.at(-1)).toMatchObject({ type: "finish", reason: "tool-calls" })
    expect(sent[0]!.body["messages"]).toEqual([
      { role: "user", content: "Add 2 and 3." },
      { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "add", arguments: "{\"a\":2,\"b\":3}" } }] },
      { role: "tool", tool_call_id: "call-1", content: "5" },
    ])
    expect(sent[0]!.body["tools"]).toMatchObject([{ type: "function", function: { name: "add", description: "Add two numbers." } }])
    expect(sent[0]!.body["tool_choice"]).toBe("auto")
    // No bill in the usage: the call is settled at its usage, at the model's price.
    expect(run.totals).toEqual({ settled: (100 * 1 + 20 * 4) / 1_000_000, reserved: 0 })
  })

  test("reads the cache's share of the input at its own price", async () => {
    const { fetch } = fakeFetch(stream(sse([delta({ content: "Hi." }, "stop"), { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 800 } } }])))
    const run = await over(fetch, options(priced), streamed)
    expect(run.totals).toEqual({ settled: (200 * 1 + 800 * 0.25 + 10 * 4) / 1_000_000, reserved: 0 })
  })

  test("says in each failure's reason whether another try is worth it; a refusal releases its hold, a 5xx settles at it", async () => {
    const statuses = [401, 403, 402, 400, 429, 503]
    const runs = await Promise.all(statuses.map((status) => over(fakeFetch(stream("{\"error\":{\"message\":\"no\"}}", status)).fetch, options(priced), streamed)))
    expect(runs.map((run) => failureOf(run.outcome))).toEqual([
      ["AuthenticationError", false], ["AuthenticationError", false], ["QuotaExhaustedError", false], ["InvalidRequestError", false], ["RateLimitError", true], ["InternalProviderError", true],
    ])
    expect(runs.map((run) => run.totals.settled > 0)).toEqual([false, false, false, false, false, true])
    expect(runs.every((run) => run.totals.reserved === 0)).toBe(true)
  })

  test("a provider that fails part way and a connection that ends early fail, worth another try, settled at the hold", async () => {
    const partWay = `data: ${JSON.stringify(delta({ content: "12" }))}\n\ndata: {"error":{"message":"upstream reset"}}\n\n`
    const early = sse([delta({ content: "12 × 3" })], false)
    const runs = await Promise.all([partWay, early].map((body) => over(fakeFetch(stream(body)).fetch, options(priced), streamed)))
    expect(runs.map((run) => failureOf(run.outcome))).toEqual([["InternalProviderError", true], ["NetworkError", true]])
    const hold = runs[0]!.totals.settled
    expect(hold).toBeGreaterThan(1000 * 4 / 1_000_000)
    expect(runs.map((run) => run.totals)).toEqual([{ settled: hold, reserved: 0 }, { settled: hold, reserved: 0 }])
  })

  test("an answer cut by its output cap before any word fails, not worth another try", async () => {
    const run = await over(fakeFetch(stream(sse([delta({ reasoning: "thinking" }, "length"), { choices: [], usage }]))).fetch, options(priced), streamed)
    expect(failureOf(run.outcome)).toEqual(["UnknownError", false])
    // Its usage came back: it is settled at what was billed.
    expect(run.totals).toEqual({ settled: 0.0002205, reserved: 0 })
  })

  test("an interrupted call is settled at the amount it held", async () => {
    const started = Effect.runSync(Deferred.make<void>())
    const hanging = (_: Sent, signal: AbortSignal) => new Response(new ReadableStream({
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(delta({ content: "12" }))}\n\n`))
        Effect.runSync(Deferred.succeed(started, undefined))
        signal.addEventListener("abort", () => controller.error(new Error("aborted")))
      },
    }), { status: 200 })
    const run = await over(fakeFetch(hanging).fetch, options(priced), Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(streamed)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
    }))
    expect(run.outcome._tag).toBe("Success")
    expect(run.totals.reserved).toBe(0)
    expect(run.totals.settled).toBeGreaterThan(1000 * 4 / 1_000_000)
  })

  test("a connection refused before the request left releases the hold, worth another try", async () => {
    const refused = () => Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }))
    const run = await over(fakeFetch(refused).fetch, options(priced), streamed)
    expect(failureOf(run.outcome)).toEqual(["NetworkError", true])
    expect(run.totals).toEqual({ settled: 0, reserved: 0 })
  })

  test("headers that do not come in time, and an answer that stops coming, fail as a lost connection and settle at the hold", async () => {
    const never = (_: Sent, signal: AbortSignal) => new Promise<Response>((_resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("aborted"))) })
    const stalls = () => new Response(new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(delta({ content: "1" }))}\n\n`)) }), { status: 200 })
    const timeouts = { response: "30 millis", idle: "30 millis" } as const
    const runs = await Promise.all([never, stalls].map((answer) => over(fakeFetch(answer).fetch, options(priced, { timeouts }), streamed)))
    expect(runs.map((run) => failureOf(run.outcome))).toEqual([["NetworkError", true], ["NetworkError", true]])
    expect(runs.map((run) => run.totals.settled > 0 && run.totals.reserved === 0)).toEqual([true, true])
  })

  test("the ledger's cap refuses a call before it is sent: the failure is the ledger's refusal, and nothing is held", async () => {
    const { fetch, sent } = fakeFetch(stream(words))
    const run = await over(fetch, options({ ...priced, caps: { total: 0.001 } }), streamed)
    expect(sent).toEqual([])
    expect(isSpendRefusal(run.outcome._tag === "Failure" ? run.outcome.failure : undefined)).toBe(true)
    expect(failureOf(run.outcome)).toEqual(["InvalidRequestError", false])
    expect(run.totals).toEqual({ settled: 0, reserved: 0 })
  })

  test("a model with no price is refused before it is sent, unless the host marks it uncapped; then nothing is held and the bill settles", async () => {
    const unpriced = callWith({ prices: {} })
    const uncapped = callWith({ prices: {}, uncapped: [MODEL] })
    const [refused, sentUncapped] = await Promise.all([unpriced, uncapped])
    expect([failureOf(refused!.run.outcome), refused!.sent.length, refused!.run.outcome._tag === "Failure" && isSpendRefusal(refused!.run.outcome.failure)]).toEqual([["InvalidRequestError", false], 0, false])
    expect([sentUncapped!.run.outcome._tag, sentUncapped!.sent.length, sentUncapped!.run.totals]).toEqual(["Success", 1, { settled: 0.0002205, reserved: 0 }])
  })

  test("a priced call with no output bound is refused before it is sent; the price's maxOutput bounds it and is sent as its cap", async () => {
    const none = await callWith({ prices: { [MODEL]: price } }, {}, false)
    const fromPrice = await callWith({ prices: { [MODEL]: { ...price, maxOutput: 300 } } }, { outputField: "max_completion_tokens" }, false)
    expect([failureOf(none.run.outcome), none.sent.length]).toEqual([["InvalidRequestError", false], 0])
    expect([fromPrice.run.outcome._tag, fromPrice.sent[0]!.body["max_completion_tokens"], fromPrice.sent[0]!.body["max_tokens"]]).toEqual(["Success", 300, undefined])
  })

  test("a request it cannot send is refused before it leaves: a file, a structured answer, an extra field a request is made of", async () => {
    const file = Prompt.make([{ role: "user", content: [{ type: "file", mediaType: "image/png", data: new Uint8Array([1]) }] }])
    const { fetch, sent } = fakeFetch(stream(words))
    const runs = await Promise.all([
      over(fetch, options(priced), LanguageModel.streamText({ prompt: file }).pipe(Stream.runCollect)),
      over(fetch, options(priced), LanguageModel.generateObject({ prompt, schema: Schema.Struct({ n: Schema.Number }) })),
      over(fetch, options(priced, { extra: { model: "another" } }), streamed),
    ])
    expect(runs.map((run) => failureOf(run.outcome))).toEqual([["InvalidRequestError", false], ["InvalidRequestError", false], ["InvalidRequestError", false]])
    expect(sent).toEqual([])
    expect(runs.map((run) => run.totals)).toEqual([{ settled: 0, reserved: 0 }, { settled: 0, reserved: 0 }, { settled: 0, reserved: 0 }])
  })

  test("an answer asked for whole is the streamed one, its text joined", async () => {
    const run = await over(fakeFetch(stream(words)).fetch, options(priced), Effect.map(LanguageModel.generateText({ prompt }), (response) => response.text))
    expect(run.outcome).toMatchObject({ _tag: "Success", success: "12 × 3 = 36." })
  })

  test("a kernel host's turn over it: the model asks for a tool, the call runs, the model answers; both calls charged", async () => {
    const { fetch } = fakeFetch((sent) => stream(Array.isArray(sent.body["messages"]) && sent.body["messages"].length > 2
      ? sse([delta({ content: "It is 5." }, "stop"), { choices: [], usage: { prompt_tokens: 50, completion_tokens: 5, cost: 0.0001 } }])
      : sse([delta({ tool_calls: [{ index: 0, id: "c1", function: { name: "add", arguments: "{\"a\":2,\"b\":3}" } }] }, "tool_calls"), { choices: [], usage: { prompt_tokens: 40, completion_tokens: 8, cost: 0.0002 } }]))())
    const turn = Effect.gen(function* () {
      const all = yield* Sessions
      const conversation = yield* all.create({ owner: "host" })
      const reply = yield* Effect.scoped(Effect.gen(function* () {
        const session = yield* all.open(conversation)
        const toolkit = yield* tools
        yield* session.append(userMessage("What is 2 + 3?"))
        for (let step = 1; step <= 3; step++) {
          const history = yield* (yield* Memory).context(session)
          const answer = yield* modelAnswer((yield* LanguageModel.LanguageModel).streamText({ prompt: Prompt.make([{ role: "system", content: "Use a tool." }, ...history]), toolkit: tools, disableToolCallResolution: true, toolCallValidation: "deferred" }), session)
          if (answer.toolCalls.length === 0) return answer.text
          for (const call of answer.toolCalls) yield* callTool(toolkit, call, session)
        }
        return "stopped"
      }))
      const journal = yield* all.read(conversation)
      return { reply, names: journal.events.map((event): string => event.name) }
    })
    const host = flatMemory.pipe(Layer.provideMerge(sessions()), Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel()), Layer.provideMerge(tools.toLayer({ add: ({ a, b }) => Effect.succeed(a + b) })))
    const run = await over(fetch, options(priced), turn.pipe(Effect.provide(host)))
    expect(run.outcome).toMatchObject({ _tag: "Success", success: { reply: "It is 5." } })
    expect(run.outcome._tag === "Success" ? run.outcome.success.names : []).toEqual([
      "core.session.turn.started", "conversation.user.message", "conversation.assistant.message", "conversation.tool.result", "conversation.assistant.message", "core.session.turn.ended",
    ])
    expect(run.totals.reserved).toBe(0)
    expect(run.totals.settled).toBeCloseTo(0.0003, 12)
  })
})

/** One streamed call with these spend options and provider options, over a fetch that answers `words`. */
const callWith = async (spend: SpendOptions, more: Partial<OpenAiCompatibleOptions> = {}, bounded = true) => {
  const { fetch, sent } = fakeFetch(stream(words))
  return { run: await over(fetch, options(spend, more, bounded), streamed), sent }
}

/** A tracer that keeps every span it opens, as Effect's own native spans. */
const recording = () => {
  const spans: Array<Tracer.Span> = []
  const tracer = Tracer.make({ span: (options) => {
    const span = new Tracer.NativeSpan(options)
    spans.push(span)
    return span
  } })
  return { spans, tracer }
}
const callSpans = (spans: ReadonlyArray<Tracer.Span>) => spans.filter((span) => span.name === "LanguageModel.streamText")

describe("the OpenAI-compatible provider's span", () => {
  test("is the call's own span (Effect AI's), given the gen_ai attributes Anthropic's provider sets, and ended with the stream: whole, cut and interrupted", async () => {
    const asked = { "gen_ai.provider.name": "openai", "gen_ai.operation.name": "chat", "gen_ai.request.model": MODEL, "gen_ai.request.max_tokens": 1000 }

    const whole = recording()
    await over(fakeFetch(stream(words)).fetch, options(priced), streamed.pipe(Effect.withTracer(whole.tracer)))
    const [answered] = callSpans(whole.spans)
    expect(answered?.status._tag).toBe("Ended")
    expect(Object.fromEntries(answered!.attributes)).toMatchObject({
      ...asked,
      "gen_ai.response.model": MODEL,
      "gen_ai.response.finish_reasons": ["stop"],
      "gen_ai.usage.input_tokens": 411,
      "gen_ai.usage.output_tokens": 81,
      "gen_ai.usage.cache_read.input_tokens": 256,
    })

    const cut = recording()
    const early = await over(fakeFetch(stream(sse([delta({ content: "12 × 3" })], false))).fetch, options(priced), streamed.pipe(Effect.withTracer(cut.tracer)))
    expect(failureOf(early.outcome)).toEqual(["NetworkError", true])
    const [lost] = callSpans(cut.spans)
    expect(lost?.status._tag).toBe("Ended")
    expect(Object.fromEntries(lost!.attributes)).toMatchObject(asked)
    expect(lost!.attributes.has("gen_ai.usage.input_tokens")).toBe(false)

    const stopped = recording()
    const started = Effect.runSync(Deferred.make<void>())
    const hanging = (_: Sent, signal: AbortSignal) => new Response(new ReadableStream({
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(delta({ content: "12" }))}\n\n`))
        Effect.runSync(Deferred.succeed(started, undefined))
        signal.addEventListener("abort", () => controller.error(new Error("aborted")))
      },
    }), { status: 200 })
    await over(fakeFetch(hanging).fetch, options(priced), Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(streamed)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
    }).pipe(Effect.withTracer(stopped.tracer)))
    const [interrupted] = callSpans(stopped.spans)
    expect(interrupted?.status._tag).toBe("Ended")
    expect(Object.fromEntries(interrupted!.attributes)).toMatchObject(asked)
  })

  test("names the provider it is told: Gemini's endpoint as gcp.gemini", async () => {
    const { spans, tracer } = recording()
    await over(fakeFetch(stream(words)).fetch, options(priced, { provider: "gcp.gemini" }), streamed.pipe(Effect.withTracer(tracer)))
    expect(callSpans(spans).map((span) => span.attributes.get("gen_ai.provider.name"))).toEqual(["gcp.gemini"])
  })
})
