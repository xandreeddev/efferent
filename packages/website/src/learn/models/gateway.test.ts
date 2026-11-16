// The gateway model against a fake fetch that answers as the gateway did on 2026-11-16 (DeepSeek V4.1 Flash on
// Baseten): reasoning deltas the page does not show, a call's arguments in pieces, two calls by index, the usage in the
// last chunk with the cached tokens, and the failures a key, a credit or a busy provider bring.
import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Option, Stream } from "effect"
import { AiError, LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { Schema } from "effect"
import { cacheKeyOf, DEFAULT_GATEWAY_MODEL, failureOf, gatewayChoice, loadGateway } from "./gateway.ts"
import type { Fetch } from "./gateway.ts"
import { chunkOf, endReading, GATEWAY_URL, readChunk, startReading, wireMessages, wireTools } from "./gateway-wire.ts"

const sse = (chunks: ReadonlyArray<unknown>) => `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`
const delta = (d: unknown, finish: string | null = null) => ({ choices: [{ delta: d, finish_reason: finish }] })
const usage = { prompt_tokens: 411, completion_tokens: 81, cost: 0.0002205, prompt_tokens_details: { cached_tokens: 256 }, completion_tokens_details: { reasoning_tokens: 11 } }

/** Two calls in one answer, each call's arguments in two pieces, after the model's own reasoning. */
const twoCalls = sse([
  delta({ role: "assistant", reasoning: "We need two sums." }),
  delta({ tool_calls: [{ index: 0, id: "call-a", type: "function", function: { name: "calculator", arguments: "" } }] }),
  delta({ tool_calls: [{ index: 0, function: { arguments: "{\"a\": 2, \"op\": \"+\", \"b\": 3}" } }] }),
  delta({ tool_calls: [{ index: 1, id: "call-b", type: "function", function: { name: "calculator", arguments: "{\"a\": 4," } }] }),
  delta({ tool_calls: [{ index: 1, function: { arguments: " \"op\": \"*\", \"b\": 5}" } }] }, "tool_calls"),
  { choices: [], usage },
])
const words = sse([delta({ role: "assistant", content: "" }), delta({ content: "12 × 3" }), delta({ content: " = 36." }, "stop"), { choices: [], usage }])

/** A fetch that answers with `body` and status, and keeps what it was sent. */
const fakeFetch = (status: number, body: string) => {
  const sent: Array<{ readonly url: string; readonly headers: Record<string, string>; readonly body: string }> = []
  const fetchFn: Fetch = (url, init) => {
    sent.push({ url, headers: init.headers, body: init.body })
    return Promise.resolve(new Response(body, { status, headers: { "content-type": "text/event-stream" } }))
  }
  return { fetchFn, sent }
}

const calculator = Tool.make("calculator", { description: "Work out a sum.", parameters: Schema.Struct({ a: Schema.Number, op: Schema.String, b: Schema.Number }), success: Schema.Number })
const prompt = Prompt.make([
  { role: "system", content: "Use a tool when it helps." },
  { role: "user", content: [{ type: "text", text: "What is 12 * 3?" }] },
  { role: "assistant", content: [{ type: "tool-call", id: "call-1", name: "calculator", params: { a: 12, op: "*", b: 3 }, providerExecuted: false }] },
  { role: "tool", content: [{ type: "tool-result", id: "call-1", name: "calculator", isFailure: false, result: 36, providerExecuted: false }] },
])

const toolkit = Toolkit.make(calculator)
/** The model's stream as the page's loop asks for it: the prompt, the toolkit, and the calls left for the loop to run. */
const streamOf = (loaded: ReturnType<typeof loadGateway>) =>
  LanguageModel.streamText({ prompt, toolkit, disableToolCallResolution: true }).pipe(Stream.provideService(LanguageModel.LanguageModel, loaded.model))
const partsOf = (fetchFn: Fetch, key = "test-key") =>
  Effect.runPromise(Stream.runCollect(streamOf(loadGateway(gatewayChoice(DEFAULT_GATEWAY_MODEL), () => Option.some(key), fetchFn))))

describe("the gateway's wire", () => {
  test("a prompt is sent with each call by its id and each result answering it", () => {
    expect(wireMessages(prompt)).toEqual([
      { role: "system", content: "Use a tool when it helps." },
      { role: "user", content: "What is 12 * 3?" },
      { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "calculator", arguments: "{\"a\":12,\"op\":\"*\",\"b\":3}" } }] },
      { role: "tool", tool_call_id: "call-1", content: "36" },
    ])
    expect(wireTools([calculator]).map((tool) => [tool.function.name, tool.function.description])).toEqual([["calculator", "Work out a sum."]])
  })

  test("a stream's calls come whole at its end, in the order asked; its reasoning is not shown; the usage says what was cached", () => {
    const chunks = twoCalls.split("\n").flatMap((line) => line.startsWith("data: ") ? Option.toArray(chunkOf(line.slice(6))) : [])
    let reading = startReading
    const streamed = chunks.flatMap((chunk) => { const read = readChunk(reading, chunk); reading = read.reading; return read.parts })
    expect(streamed).toEqual([])
    expect(endReading(reading)).toEqual([
      { type: "tool-call", id: "call-a", name: "calculator", params: { a: 2, op: "+", b: 3 }, providerExecuted: false },
      { type: "tool-call", id: "call-b", name: "calculator", params: { a: 4, op: "*", b: 5 }, providerExecuted: false },
      { type: "finish", reason: "tool-calls", usage: { inputTokens: { total: 411, cacheRead: 256, uncached: 155 }, outputTokens: { total: 81, reasoning: 11 } } },
    ])
  })
})

describe("the gateway model", () => {
  test("an answer streams as text, named for the model, and the request goes to the gateway's one address with the key in its header alone", async () => {
    const { fetchFn, sent } = fakeFetch(200, words)
    const parts = await partsOf(fetchFn)
    expect(parts.map((part) => part.type)).toEqual(["response-metadata", "text-start", "text-delta", "text-delta", "text-end", "finish"])
    expect(parts[0]).toMatchObject({ modelId: `gateway:${DEFAULT_GATEWAY_MODEL}` })
    expect(sent.map((one) => one.url)).toEqual([`${GATEWAY_URL}/chat/completions`])
    expect(sent[0]!.headers.authorization).toBe("Bearer test-key")
    expect(sent[0]!.body).not.toContain("test-key")
    const body = JSON.parse(sent[0]!.body)
    expect([body.model, body.stream, body.reasoning, body.max_tokens, body.providerOptions]).toEqual([DEFAULT_GATEWAY_MODEL, true, undefined, 4096, { gateway: { order: ["baseten"] } }])
  })

  test("two calls in one answer reach the loop as two calls", async () => {
    const parts = await partsOf(fakeFetch(200, twoCalls).fetchFn)
    expect(parts.flatMap((part) => (part.type === "tool-call" ? [[part.id, part.params]] : []))).toEqual([["call-a", { a: 2, op: "+", b: 3 }], ["call-b", { a: 4, op: "*", b: 5 }]])
  })

  test("the requests of one conversation share a cache key, and another conversation's differs", () => {
    const one = { messages: [{ role: "system", content: "s" }, { role: "user", content: "first" }] }
    expect(cacheKeyOf({ messages: [...one.messages, { role: "assistant", content: "later" }] })).toBe(cacheKeyOf(one))
    expect(cacheKeyOf({ messages: [{ role: "system", content: "s" }, { role: "user", content: "another" }] })).not.toBe(cacheKeyOf(one))
  })

  test("a refused key, no credit and a busy provider fail in words; only the busy one is worth another try", async () => {
    const failure = async (status: number) => {
      const exit = await Effect.runPromiseExit(Stream.runDrain(streamOf(loadGateway(gatewayChoice(DEFAULT_GATEWAY_MODEL), () => Option.some("k"), fakeFetch(status, "{\"error\":{\"message\":\"no\"}}").fetchFn))))
      const error = exit._tag === "Failure" ? exit.cause.reasons.find((reason) => reason._tag === "Fail") : undefined
      return error !== undefined && error._tag === "Fail" && AiError.isAiError(error.error) ? [error.error.reason._tag, error.error.isRetryable] : ["none"]
    }
    expect(await failure(401)).toEqual(["AuthenticationError", false])
    expect(await failure(402)).toEqual(["QuotaExhaustedError", false])
    expect(await failure(429)).toEqual(["RateLimitError", true])
    expect(await failure(503)).toEqual(["InternalProviderError", true])
    expect(failureOf(401, "").message).toContain("The gateway refused the key")
    expect(failureOf(402, "").message).toBe("gateway.streamText: Quota exhausted. Check your account billing and usage limits.")
  })

  /** The failure an answer ended with: its reason's tag, whether it is worth another try, and its words. */
  const endedWith = async (fetchFn: Fetch, keyOf: () => Option.Option<string> = () => Option.some("k")) => {
    const exit = await Effect.runPromiseExit(Stream.runDrain(streamOf(loadGateway(gatewayChoice(DEFAULT_GATEWAY_MODEL), keyOf, fetchFn))))
    const error = exit._tag === "Failure" ? exit.cause.reasons.find((reason) => reason._tag === "Fail") : undefined
    return error !== undefined && error._tag === "Fail" && AiError.isAiError(error.error) ? [error.error.reason._tag, error.error.isRetryable, error.error.message] : ["none"]
  }

  test("a provider that fails part way, a connection that ends early, and an answer cut before any word each fail in words", async () => {
    const partWay = `data: ${JSON.stringify(delta({ content: "12" }))}\n\ndata: {"error":{"message":"upstream reset"}}\n\n`
    expect(await endedWith(fakeFetch(200, partWay).fetchFn)).toEqual(["InternalProviderError", true, "gateway.streamText: Internal provider error: The model's provider failed part way through the answer: upstream reset"])
    const early = `data: ${JSON.stringify(delta({ content: "12 × 3" }))}\n\n`
    expect(await endedWith(fakeFetch(200, early).fetchFn)).toEqual(["InternalProviderError", true, "gateway.streamText: Internal provider error: The answer stopped before it was finished: the connection to the gateway ended early."])
    const cut = sse([delta({ role: "assistant", reasoning: "thinking" }, "length"), { choices: [], usage }])
    expect((await endedWith(fakeFetch(200, cut).fetchFn)).slice(0, 2)).toEqual(["UnknownError", false])
  })

  test("a line and a character split across two reads are put back together", async () => {
    const whole = words
    const at = whole.indexOf("×") + 1
    const bytes = new TextEncoder().encode(whole)
    const cutAt = new TextEncoder().encode(whole.slice(0, at)).length - 1
    const split: Fetch = () => Promise.resolve(new Response(new ReadableStream({ start: (controller) => { controller.enqueue(bytes.slice(0, cutAt)); controller.enqueue(bytes.slice(cutAt)); controller.close() } }), { status: 200 }))
    const parts = await Effect.runPromise(Stream.runCollect(streamOf(loadGateway(gatewayChoice(DEFAULT_GATEWAY_MODEL), () => Option.some("k"), split))))
    expect(parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : [])).join("")).toBe("12 × 3 = 36.")
  })

  test("with no key kept, a request fails in words and nothing is sent", async () => {
    const { fetchFn, sent } = fakeFetch(200, words)
    expect((await endedWith(fetchFn, () => Option.none())).slice(0, 2)).toEqual(["AuthenticationError", false])
    expect(sent).toEqual([])
  })

  test("an answer asked for whole is the streamed one, its text joined", async () => {
    const loaded = loadGateway(gatewayChoice(DEFAULT_GATEWAY_MODEL), () => Option.some("k"), fakeFetch(200, words).fetchFn)
    const response = await Effect.runPromise(LanguageModel.generateText({ prompt, toolkit, disableToolCallResolution: true }).pipe(Effect.provideService(LanguageModel.LanguageModel, loaded.model)))
    expect(response.text).toBe("12 × 3 = 36.")
  })

  test("Stop aborts every request in flight", async () => {
    let aborted = 0
    const hanging: Fetch = (_url, init) => new Promise((_, reject) => { init.signal.addEventListener("abort", () => { aborted++; reject(new Error("aborted")) }) })
    const loaded = loadGateway(gatewayChoice(DEFAULT_GATEWAY_MODEL), () => Option.some("k"), hanging)
    const run = Effect.runFork(Stream.runDrain(streamOf(loaded)))
    await new Promise((resolve) => setTimeout(resolve, 20))
    loaded.interrupt()
    expect(aborted).toBe(1)
    // An aborted answer never ends as if it were whole: left alone, it fails in words.
    const exit = await Effect.runPromise(Fiber.await(run))
    expect(exit._tag).toBe("Failure")
    expect(JSON.stringify(exit)).toContain("The answer was stopped.")
  })
})
