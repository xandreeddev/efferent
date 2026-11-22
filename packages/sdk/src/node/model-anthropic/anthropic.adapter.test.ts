// The Anthropic provider over a fake `fetch` that answers with the Messages API's stream, as recorded shapes: no
// network. What Anthropic counts (the input without the cache's shares) is settled at the model's prices.
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Redacted, Schema, Stream, Tracer } from "effect"
import { AiError, LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import { kernel, ModelSpend, modelSpendMemory, Sessions, userMessage } from "@xandreed/core"
import { callTool, flatMemory, inProcessJournal, Memory, modelAnswer, sessions } from "../../index.js"
import { isSpendRefusal } from "../model-spend/model-spend.entity.functions.js"
import type { SpendOptions } from "../model-spend/model-spend.entity.js"
import { anthropicModel } from "./anthropic.adapter.js"
import type { AnthropicOptions } from "./anthropic.entity.js"

const MODEL = "claude-haiku-4-5"
const BASE = "https://anthropic.test"
const price = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }

const sse = (events: ReadonlyArray<{ readonly type: string; readonly [field: string]: unknown }>) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")
const start = (usage: Record<string, number>) => ({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage } })
const textBlock = (text: ReadonlyArray<string>) => [
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  ...text.map((piece) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } })),
  { type: "content_block_stop", index: 0 },
]
const end = (stop: string, usage: Record<string, number>) => [{ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage }, { type: "message_stop" }]
const words = sse([start({ input_tokens: 20, output_tokens: 1, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 }), ...textBlock(["12 × 3", " = 36."]), ...end("end_turn", { output_tokens: 12 })])
const call = sse([
  start({ input_tokens: 40, output_tokens: 1 }),
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "add", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"a\": 2," } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: " \"b\": 3}" } },
  { type: "content_block_stop", index: 0 },
  ...end("tool_use", { output_tokens: 9 }),
])
const answered = sse([start({ input_tokens: 60, output_tokens: 1 }), ...textBlock(["It is 5."]), ...end("end_turn", { output_tokens: 4 })])

interface Sent { readonly url: string; readonly headers: Headers; readonly body: Record<string, unknown> }
type Answer = (sent: Sent, signal: AbortSignal) => Response | Promise<Response>

const fakeFetch = (answer: Answer) => {
  const sent: Array<Sent> = []
  const fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const one: Sent = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(await new Response(init?.body ?? "").text()) }
    sent.push(one)
    return answer(one, init?.signal ?? new AbortController().signal)
  }, { preconnect: () => {} })
  return { fetch, sent }
}
const stream = (body: string, status = 200) => () => new Response(body, { status, headers: { "content-type": status === 200 ? "text/event-stream" : "application/json", "request-id": "req_1" } })
const refusal = (type: string) => JSON.stringify({ type: "error", error: { type, message: "no" } })

const priced: SpendOptions = { prices: { [MODEL]: price } }
const options = (spend: SpendOptions, more: Partial<AnthropicOptions> = {}): AnthropicOptions => ({ model: MODEL, apiKey: Redacted.make("test-key"), baseUrl: BASE, maxOutputTokens: 1000, spend, ...more })

const over = <A, E>(fetch: ReturnType<typeof fakeFetch>["fetch"], provider: AnthropicOptions, body: Effect.Effect<A, E, LanguageModel.LanguageModel | ModelSpend>) =>
  Effect.runPromise(Effect.gen(function* () {
    const outcome = yield* Effect.result(body)
    return { outcome, totals: yield* (yield* ModelSpend).totals }
  }).pipe(Effect.provide(anthropicModel(provider).pipe(Layer.provideMerge(modelSpendMemory))), Effect.provideService(FetchHttpClient.Fetch, fetch)))

const Add = Tool.make("add", { description: "Add two numbers.", parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }), success: Schema.Number })
const tools = Toolkit.make(Add)
const prompt = Prompt.make([{ role: "system", content: "Use a tool when it helps." }, { role: "user", content: [{ type: "text", text: "What is 12 * 3?" }] }])
const streamed = LanguageModel.streamText({ prompt, toolkit: tools, disableToolCallResolution: true }).pipe(Stream.runCollect)

const failureOf = (outcome: { readonly _tag: string; readonly failure?: unknown }) =>
  outcome._tag === "Failure" && AiError.isAiError(outcome.failure) ? [outcome.failure.reason._tag, outcome.failure.isRetryable] : ["none"]

describe("the Anthropic provider", () => {
  test("streams an answer; the key goes in its header; the request asks for the prompt to be cached; settled at the usage, cache shares at their prices", async () => {
    const { fetch, sent } = fakeFetch(stream(words))
    const run = await over(fetch, options(priced), streamed)
    const parts = run.outcome._tag === "Success" ? run.outcome.success : []
    expect(parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : [])).join("")).toBe("12 × 3 = 36.")
    expect(parts.at(-1)).toMatchObject({ type: "finish", reason: "stop", usage: { inputTokens: { total: 1220, cacheRead: 1000, cacheWrite: 200 }, outputTokens: { total: 12 } } })
    expect(sent.map((one) => [one.url, one.headers.get("x-api-key")])).toEqual([[`${BASE}/v1/messages`, "test-key"]])
    expect([sent[0]!.body["model"], sent[0]!.body["max_tokens"], sent[0]!.body["stream"], sent[0]!.body["cache_control"]]).toEqual([MODEL, 1000, true, { type: "ephemeral" }])
    expect(run.totals).toEqual({ settled: (20 * 1 + 1000 * 0.1 + 200 * 1.25 + 12 * 5) / 1_000_000, reserved: 0 })
  })

  test("sends no cache mark with the cache off, and a one-hour one asked for", async () => {
    const off = fakeFetch(stream(words))
    const hour = fakeFetch(stream(words))
    await over(off.fetch, options(priced, { cache: "off" }), streamed)
    await over(hour.fetch, options(priced, { cache: "1h" }), streamed)
    expect([off.sent[0]!.body["cache_control"], hour.sent[0]!.body["cache_control"]]).toEqual([undefined, { type: "ephemeral", ttl: "1h" }])
  })

  test("asks for adaptive thinking at an effort, and nothing of it without one; the thinking comes back signed and goes back as it came", async () => {
    const plain = fakeFetch(stream(words))
    await over(plain.fetch, options(priced), streamed)
    expect([plain.sent[0]!.body["thinking"], plain.sent[0]!.body["output_config"]]).toEqual([undefined, undefined])
    // A thinking block's start as the gateway sends it, with no `signature` key (Anthropic's own API sends it empty).
    const thought = sse([
      start({ input_tokens: 40, output_tokens: 1 }),
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Twelve threes." } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-1" } },
      { type: "content_block_stop", index: 0 },
      ...textBlock(["36."]).map((event) => ("index" in event ? { ...event, index: 1 } : event)),
      ...end("end_turn", { output_tokens: 9 }),
    ])
    const high = fakeFetch(stream(thought))
    const run = await over(high.fetch, options(priced, { effort: "high" }), streamed)
    expect([high.sent[0]!.body["thinking"], high.sent[0]!.body["output_config"]]).toEqual([{ type: "adaptive" }, { effort: "high" }])
    const parts = run.outcome._tag === "Success" ? run.outcome.success : []
    expect(parts.flatMap((part) => (part.type === "reasoning-delta" ? [part.delta] : [])).join("")).toBe("Twelve threes.")
    const signed = parts.flatMap((part) => (part.type === "reasoning-delta" && Object.keys(part.metadata).length > 0 ? [part.metadata] : []))
    expect(signed).toEqual([{ anthropic: { info: { type: "thinking", signature: "sig-1" } } }])
    // The reasoning part sent back with that metadata as its options is the thinking block, before the answer's text.
    const again = fakeFetch(stream(words))
    const back = Prompt.make([
      { role: "user", content: [{ type: "text", text: "What is 12 * 3?" }] },
      { role: "assistant", content: [{ type: "reasoning", text: "Twelve threes.", options: signed[0]! }, { type: "text", text: "36." }] },
      { role: "user", content: [{ type: "text", text: "And 12 * 4?" }] },
    ])
    await over(again.fetch, options(priced, { effort: "high" }), LanguageModel.streamText({ prompt: back }).pipe(Stream.runCollect))
    expect((again.sent[0]!.body["messages"] as ReadonlyArray<{ readonly content: unknown }>)[1]!.content).toEqual([
      { type: "thinking", thinking: "Twelve threes.", signature: "sig-1" },
      { type: "text", text: "36." },
    ])
  })

  test("a thinking start read the same in Anthropic's shape (signature empty) and the gateway's (none), whole or in chunks cut mid-line and mid-character", async () => {
    const thinking = (block: Record<string, unknown>) => sse([
      start({ input_tokens: 40, output_tokens: 1 }),
      { type: "content_block_start", index: 0, content_block: block },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Été × 3." } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-2" } },
      { type: "content_block_stop", index: 0 },
      ...end("end_turn", { output_tokens: 5 }),
    ])
    const chunked = (body: string) => () => {
      const bytes = new TextEncoder().encode(body)
      const pieces = Array.from({ length: Math.ceil(bytes.length / 7) }, (_, i) => bytes.slice(i * 7, i * 7 + 7))
      return new Response(new ReadableStream({ start: (controller) => { for (const piece of pieces) controller.enqueue(piece); controller.close() } }), { status: 200, headers: { "content-type": "text/event-stream" } })
    }
    const read = async (answer: Answer) => {
      const run = await over(fakeFetch(answer).fetch, options(priced, { effort: "high" }), streamed)
      const parts = run.outcome._tag === "Success" ? run.outcome.success : []
      return [parts.flatMap((part) => (part.type === "reasoning-delta" ? [part.delta] : [])).join(""), parts.flatMap((part) => (part.type === "reasoning-delta" && Object.keys(part.metadata).length > 0 ? [part.metadata] : []))]
    }
    const anthropic = thinking({ type: "thinking", thinking: "", signature: "" })
    const gateway = thinking({ type: "thinking", thinking: "" })
    const expected = ["Été × 3.", [{ anthropic: { info: { type: "thinking" as const, signature: "sig-2" } } }]]
    expect([await read(stream(anthropic)), await read(stream(gateway)), await read(chunked(anthropic)), await read(chunked(gateway))]).toEqual([expected, expected, expected, expected])
  })

  test("says in each failure's reason whether another try is worth it; a refusal releases its hold, an overload settles at it", async () => {
    const cases = [[401, "authentication_error"], [403, "permission_error"], [400, "invalid_request_error"], [429, "rate_limit_error"], [529, "overloaded_error"]] as const
    const runs = await Promise.all(cases.map(([status, type]) => over(fakeFetch(stream(refusal(type), status)).fetch, options(priced), streamed)))
    expect(runs.map((run) => failureOf(run.outcome)[1])).toEqual([false, false, false, true, true])
    expect(runs.map((run) => run.totals.settled > 0)).toEqual([false, false, false, false, true])
    expect(runs.every((run) => run.totals.reserved === 0)).toBe(true)
  })

  test("a stream cut after it started settles at the hold", async () => {
    const cut = sse([start({ input_tokens: 20, output_tokens: 1 }), ...textBlock(["12"]).slice(0, 2)])
    const run = await over(fakeFetch(stream(cut)).fetch, options(priced), streamed)
    expect(run.outcome._tag).toBe("Failure")
    expect(run.totals.reserved).toBe(0)
    expect(run.totals.settled).toBeGreaterThan(1000 * 5 / 1_000_000)
  })

  test("an interrupted call settles at the hold; a connection refused releases it", async () => {
    const started = Effect.runSync(Deferred.make<void>())
    const hanging = (_: Sent, signal: AbortSignal) => new Response(new ReadableStream({
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode(sse([start({ input_tokens: 20, output_tokens: 1 }), ...textBlock(["12"]).slice(0, 2)])))
        Effect.runSync(Deferred.succeed(started, undefined))
        signal.addEventListener("abort", () => controller.error(new Error("aborted")))
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } })
    const interrupted = await over(fakeFetch(hanging).fetch, options(priced), Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(streamed)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
    }))
    const refused = await over(fakeFetch(() => Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }))).fetch, options(priced), streamed)
    expect([interrupted.totals.reserved, interrupted.totals.settled > 1000 * 5 / 1_000_000]).toEqual([0, true])
    expect([failureOf(refused.outcome), refused.totals]).toEqual([["NetworkError", true], { settled: 0, reserved: 0 }])
  })

  test("the ledger's cap refuses a call before it is sent, with the ledger's refusal; a model with no price is refused too", async () => {
    const capped = fakeFetch(stream(words))
    const unpriced = fakeFetch(stream(words))
    const overCap = await over(capped.fetch, options({ ...priced, caps: { total: 0.001 } }), streamed)
    const noPrice = await over(unpriced.fetch, options({ prices: {} }), streamed)
    expect([capped.sent.length, unpriced.sent.length]).toEqual([0, 0])
    expect([isSpendRefusal(overCap.outcome._tag === "Failure" ? overCap.outcome.failure : undefined), failureOf(overCap.outcome)]).toEqual([true, ["InvalidRequestError", false]])
    expect([isSpendRefusal(noPrice.outcome._tag === "Failure" ? noPrice.outcome.failure : undefined), failureOf(noPrice.outcome)]).toEqual([false, ["InvalidRequestError", false]])
    expect([overCap.totals, noPrice.totals]).toEqual([{ settled: 0, reserved: 0 }, { settled: 0, reserved: 0 }])
  })

  test("an answer asked for whole is charged as one call", async () => {
    const whole = JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: MODEL, content: [{ type: "text", text: "36." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 30, output_tokens: 3 } })
    const run = await over(fakeFetch(() => new Response(whole, { status: 200, headers: { "content-type": "application/json" } })).fetch, options(priced), Effect.map(LanguageModel.generateText({ prompt }), (response) => response.text))
    expect(run.outcome).toMatchObject({ _tag: "Success", success: "36." })
    expect(run.totals).toEqual({ settled: (30 * 1 + 3 * 5) / 1_000_000, reserved: 0 })
  })

  test("a kernel host's turn over it: the model asks for a tool, the call runs, the model answers; both calls charged", async () => {
    const { fetch } = fakeFetch((one) => stream(Array.isArray(one.body["messages"]) && one.body["messages"].length > 1 ? answered : call)())
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
          for (const one of answer.toolCalls) yield* callTool(toolkit, one, session)
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
    expect(run.totals.settled).toBeCloseTo((40 + 9 * 5 + 60 + 4 * 5) / 1_000_000, 12)
  })
})

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

describe("the Anthropic provider's span", () => {
  test("is the call's own span (Effect AI's), with the provider's gen_ai attributes, ended with the stream: whole, cut and interrupted", async () => {
    const asked = { "gen_ai.provider.name": "anthropic", "gen_ai.operation.name": "chat", "gen_ai.request.model": MODEL, "gen_ai.request.max_tokens": 1000 }

    const whole = recording()
    await over(fakeFetch(stream(words)).fetch, options(priced), streamed.pipe(Effect.withTracer(whole.tracer)))
    const [answered] = callSpans(whole.spans)
    expect(answered?.status._tag).toBe("Ended")
    expect(Object.fromEntries(answered!.attributes)).toMatchObject({
      ...asked,
      "gen_ai.response.model": MODEL,
      "gen_ai.usage.input_tokens": 1220,
      "gen_ai.usage.output_tokens": 12,
      "gen_ai.usage.cache_read.input_tokens": 1000,
      "gen_ai.usage.cache_write.input_tokens": 200,
    })

    const cut = recording()
    const early = await over(fakeFetch(stream(sse([start({ input_tokens: 20, output_tokens: 1 }), ...textBlock(["12"]).slice(0, 2)]))).fetch, options(priced), streamed.pipe(Effect.withTracer(cut.tracer)))
    expect(early.outcome._tag).toBe("Failure")
    const [lost] = callSpans(cut.spans)
    expect(lost?.status._tag).toBe("Ended")
    expect(Object.fromEntries(lost!.attributes)).toMatchObject(asked)

    const stopped = recording()
    const started = Effect.runSync(Deferred.make<void>())
    const hanging = (_: Sent, signal: AbortSignal) => new Response(new ReadableStream({
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode(sse([start({ input_tokens: 20, output_tokens: 1 }), ...textBlock(["12"]).slice(0, 2)])))
        Effect.runSync(Deferred.succeed(started, undefined))
        signal.addEventListener("abort", () => controller.error(new Error("aborted")))
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } })
    await over(fakeFetch(hanging).fetch, options(priced), Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(streamed)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
    }).pipe(Effect.withTracer(stopped.tracer)))
    const [interrupted] = callSpans(stopped.spans)
    expect(interrupted?.status._tag).toBe("Ended")
    expect(Object.fromEntries(interrupted!.attributes)).toMatchObject(asked)
  })
})
