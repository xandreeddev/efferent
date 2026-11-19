// The OpenAI-compatible embedder over a fake `fetch` shaped like the `/embeddings` wire: a vector per text by its
// `index` (given here last first), and the usage. The gateway's embeddings answer gave its tokens and no cost on
// 2026-11-19; a provider that reports a cost (as text, as the gateway's chat answer does) is settled at it, which the
// fake's default answer holds. A local server for the export. No network but the loopback.
import { describe, expect, test } from "bun:test"
import { Cause, Context, Effect, Layer, Metric, Option, Redacted, Result, Tracer } from "effect"
import { AiError } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import { ModelSpend, modelSpendMemory } from "@xandreed/core/kernel"
import { cosine, Embedder, embedderConformance } from "../../index.js"
import { failedChecks } from "../testing.js"
import { flushTelemetry, otlpTelemetry } from "../index.js"
import { isSpendRefusal, spendRefusalOf } from "../model-spend/model-spend.entity.functions.js"
import { modelCalls, modelCost, modelTokens } from "../model-spend/model-spend.entity.js"
import type { SpendOptions } from "../model-spend/model-spend.entity.js"
import { openAiCompatibleEmbedder } from "./openai-compatible-embedder.adapter.js"
import { batchesOf, embedderNameOf, optionsProblem, reportedOf, unitLength, vectorsOf } from "./openai-compatible-embedder.entity.functions.js"
import type { OpenAiCompatibleEmbedderOptions } from "./openai-compatible-embedder.entity.js"

const MODEL = "openai/text-embedding-3-small"
const BASE = "https://gateway.test/v1"
const price = { input: 0.02, output: 0 }
const priced: SpendOptions = { prices: { [MODEL]: price } }
const TEXTS = ["a cat sat on the mat", "the stock price fell 4%", "a lemon cake with icing"]
const LETTERS = "abcdefghijklmnopqrstuvwxyz0123456789 %:"

interface Sent { readonly url: string; readonly headers: Headers; readonly body: { readonly model: string; readonly input: ReadonlyArray<string>; readonly dimensions?: number } }
type Answer = (sent: Sent) => Response | Promise<Response>

/** A text's vector as the fake model makes it: three times its count of each letter, cut to `dimensions`; never unit length. */
const vectorOf = (text: string, dimensions?: number): Array<number> =>
  Array.from(LETTERS, (letter) => 3 * Array.from(text.toLowerCase()).filter((one) => one === letter).length).slice(0, dimensions ?? LETTERS.length)

/** The wire's answer to what was sent: each text's vector by its index, given last first, and the usage. */
const embeddings = (sent: Sent, usage: unknown = { prompt_tokens: sent.body.input.join("").length, total_tokens: sent.body.input.join("").length, cost: "0.0000012" }) =>
  Response.json({
    object: "list",
    model: sent.body.model,
    data: sent.body.input.map((text, index) => ({ object: "embedding", index, embedding: vectorOf(text, sent.body.dimensions) })).toReversed(),
    usage,
  })

/** A `fetch` that answers each request with `answer` and keeps what it was sent. */
const fakeFetch = (answer: Answer = (sent) => embeddings(sent)) => {
  const sent: Array<Sent> = []
  const fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const one: Sent = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(await new Response(init?.body ?? "").text()) }
    sent.push(one)
    return answer(one)
  }, { preconnect: () => {} })
  return { fetch, sent }
}

const options = (more: Partial<OpenAiCompatibleEmbedderOptions> = {}): OpenAiCompatibleEmbedderOptions => ({
  model: MODEL, baseUrl: BASE, apiKey: Redacted.make("test-key"), spend: priced, ...more,
})

/** Run `body` over the embedder and a fresh ledger, with `fetch` as the transport: its outcome and the ledger's totals. */
const over = <A, E>(fetch: ReturnType<typeof fakeFetch>["fetch"], embedder: OpenAiCompatibleEmbedderOptions, body: Effect.Effect<A, E, Embedder | ModelSpend>) =>
  Effect.runPromise(Effect.gen(function* () {
    const outcome = yield* Effect.result(body)
    return { outcome, totals: yield* (yield* ModelSpend).totals }
  }).pipe(Effect.provide(openAiCompatibleEmbedder(embedder).pipe(Layer.provideMerge(modelSpendMemory))), Effect.provideService(FetchHttpClient.Fetch, fetch)))

const embedded = (texts: ReadonlyArray<string>, as: "query" | "passage" = "passage") => Effect.flatMap(Embedder, (embedder) => embedder.embed(texts, as))

/** The failure an embed ended with: its tag, the tag of its cause, whether that cause is worth another try, its words. */
const failureOf = (outcome: { readonly _tag: string; readonly failure?: unknown }) => {
  if (outcome._tag !== "Failure" || typeof outcome.failure !== "object" || outcome.failure === null) return ["none"]
  const failure = outcome.failure as { readonly _tag: string; readonly message: string; readonly cause?: unknown }
  const cause = failure.cause
  return [failure._tag, AiError.isAiError(cause) ? cause.reason._tag : (cause as { readonly _tag?: string } | undefined)?._tag, AiError.isAiError(cause) ? cause.isRetryable : undefined, failure.message]
}

describe("the OpenAI-compatible embedder", () => {
  test("passes the embedder kit, with and without prefixes, its vectors cut to fewer dimensions", async () => {
    for (const more of [{}, { prefixes: { query: "query: ", passage: "passage: " } }, { dimensions: 20 }]) {
      const { fetch } = fakeFetch()
      const checks = embedderConformance({
        texts: TEXTS,
        open: Effect.map(Layer.build(openAiCompatibleEmbedder(options(more)).pipe(Layer.provide(modelSpendMemory), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))), (built) => Context.get(built, Embedder)),
      })
      expect(await failedChecks(checks)).toEqual([])
    }
  })

  test("posts the texts to /embeddings with the model, the key in a header alone, each text after its prefix", async () => {
    const { fetch, sent } = fakeFetch()
    const run = await over(fetch, options({ baseUrl: `${BASE}/`, prefixes: { query: "query: ", passage: "passage: " }, dimensions: 8 }), Effect.all([embedded(["one"], "query"), embedded(["two"], "passage")], { concurrency: 1 }))
    expect(run.outcome._tag).toBe("Success")
    expect(sent.map((one) => [one.url, one.headers.get("authorization"), one.body])).toEqual([
      [`${BASE}/embeddings`, "Bearer test-key", { model: MODEL, input: ["query: one"], dimensions: 8 }],
      [`${BASE}/embeddings`, "Bearer test-key", { model: MODEL, input: ["passage: two"], dimensions: 8 }],
    ])
  })

  test("sends no prefix and no dimensions when the options name none, and no key when it has none", async () => {
    const { fetch, sent } = fakeFetch()
    await over(fetch, { model: MODEL, baseUrl: BASE, spend: priced }, embedded(["one"], "query"))
    expect(sent.map((one) => [one.headers.get("authorization"), one.body])).toEqual([[null, { model: MODEL, input: ["one"] }]])
  })

  test("sends many texts in batches, one after another, and gives their vectors in the texts' order, each of unit length", async () => {
    const { fetch, sent } = fakeFetch()
    const texts = ["ab", "bc", "cd", "de", "ef"]
    const run = await over(fetch, options({ batch: 2 }), embedded(texts))
    expect(sent.map((one) => one.body.input)).toEqual([["ab", "bc"], ["cd", "de"], ["ef"]])
    const vectors = run.outcome._tag === "Success" ? run.outcome.success : []
    expect(vectors.length).toBe(5)
    for (const [index, text] of texts.entries()) {
      expect(cosine(vectors[index]!, vectorOf(text))).toBeCloseTo(1, 12)
      expect(Math.hypot(...vectors[index]!)).toBeCloseTo(1, 12)
    }
    // Five texts at 2 bytes, three requests each billed 0.0000012.
    expect(run.totals).toEqual({ settled: 3 * 0.0000012, reserved: 0 })
  })

  test("no texts send nothing and hold nothing", async () => {
    const { fetch, sent } = fakeFetch()
    const run = await over(fetch, options({ spend: { prices: {} } }), Effect.all([embedded([], "query"), embedded([], "passage")], { concurrency: 1 }))
    expect(run.outcome._tag === "Success" ? run.outcome.success : undefined).toEqual([[], []])
    expect(sent).toEqual([])
  })
})

describe("the embedder's name, which keys its vectors", () => {
  test("is made of the model, the dimensions and the prefixes, so two configurations of one model never share a name", () => {
    const names = [
      embedderNameOf({ model: MODEL }),
      embedderNameOf({ model: MODEL, dimensions: 512 }),
      embedderNameOf({ model: MODEL, dimensions: 256 }),
      embedderNameOf({ model: MODEL, prefixes: { query: "query: ", passage: "passage: " } }),
      embedderNameOf({ model: MODEL, prefixes: { query: "query: " } }),
      embedderNameOf({ model: MODEL, prefixes: { passage: "query: " } }),
      embedderNameOf({ model: MODEL, dimensions: 512, prefixes: { query: "q", passage: "p" } }),
    ]
    expect(names).toEqual([
      MODEL,
      `${MODEL} dimensions=512`,
      `${MODEL} dimensions=256`,
      `${MODEL} prefixes=["query: ","passage: "]`,
      `${MODEL} prefixes=["query: ",""]`,
      `${MODEL} prefixes=["","query: "]`,
      `${MODEL} dimensions=512 prefixes=["q","p"]`,
    ])
    expect(new Set(names).size).toBe(names.length)
    // Empty prefixes are none: the same vectors, the same name.
    expect(embedderNameOf({ model: MODEL, prefixes: { query: "", passage: "" } })).toBe(MODEL)
    // A prefix that holds a quote or the separator stays one name: each is JSON-quoted.
    expect(embedderNameOf({ model: "m", prefixes: { query: "a\",\"b", passage: "" } })).not.toBe(embedderNameOf({ model: "m", prefixes: { query: "a", passage: "b" } }))
  })

  test("is the embedder's model, or the host's own name", async () => {
    const names = await Promise.all([options({ dimensions: 768 }), options({ name: "notes-v2" })].map((given) =>
      over(fakeFetch().fetch, given, Effect.map(Embedder, (embedder) => embedder.model))))
    expect(names.map((run) => (run.outcome._tag === "Success" ? run.outcome.success : ""))).toEqual([`${MODEL} dimensions=768`, "notes-v2"])
  })

  test("options that make no embedder are refused in words: a name too long to key a vector, a line break, a batch or dimensions that are no count", () => {
    const long = "m".repeat(100)
    expect([
      optionsProblem(options({ model: long })),
      optionsProblem(options({ name: "a\nb" })),
      optionsProblem(options({ name: "" })),
      optionsProblem(options({ batch: 0 })),
      optionsProblem(options({ dimensions: 1.5 })),
      optionsProblem(options({ model: " " })),
      optionsProblem(options({ name: "m".repeat(99) })),
    ].map((problem) => Option.getOrElse(problem, () => "none"))).toEqual([
      `the name "${long}" is 100 characters, over 99: give the embedder a shorter name of its own (name), one no other configuration has`,
      "the name holds a line break, and a vector's key is the name, a line feed and the text",
      "the name is one or more characters",
      "batch is a whole number of 1 or more, not 0",
      "dimensions is a whole number of 1 or more, not 1.5",
      "a model is named by one or more characters",
      "none",
    ])
  })

  test("the layer dies where it is built for such options", async () => {
    const exit = await Effect.runPromiseExit(Layer.build(openAiCompatibleEmbedder(options({ batch: -1 })).pipe(Layer.provide(modelSpendMemory))).pipe(Effect.scoped))
    expect(exit._tag).toBe("Failure")
    expect(Cause.pretty(exit._tag === "Failure" ? exit.cause : Cause.empty)).toContain("openAiCompatibleEmbedder: batch is a whole number of 1 or more, not -1")
  })
})

describe("the embedder's vectors, read from the wire", () => {
  test("are put in the texts' order by index and made unit length", () => {
    const read = vectorsOf({ data: [{ index: 1, embedding: [0, 2] }, { index: 0, embedding: [3, 4] }] }, 2, undefined)
    expect(read).toEqual(Result.succeed([[0.6, 0.8], [0, 1]]))
    expect(unitLength([0, 0])).toEqual(Option.none())
  })

  test("are refused, in words, when one is missing or twice, no vector, all zeros, of two lengths or another length than asked", () => {
    const problems = [
      vectorsOf({ data: [{ index: 0, embedding: [1] }] }, 2, undefined),
      vectorsOf({ data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [1] }] }, 2, undefined),
      vectorsOf({ data: [{ index: 0, embedding: [] }] }, 1, undefined),
      vectorsOf({ data: [{ index: 0, embedding: [Number.NaN] }] }, 1, undefined),
      vectorsOf({ data: [{ index: 0, embedding: [0, 0] }] }, 1, undefined),
      vectorsOf({ data: [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [1] }] }, 2, undefined),
      vectorsOf({ data: [{ index: 0, embedding: [1, 0] }] }, 1, 3),
    ].map((read) => (read._tag === "Failure" ? read.failure : "read"))
    expect(problems).toEqual([
      "the provider gave 1 vectors for 2 texts",
      "the provider gave no vector for the text at 1",
      "the vector of the text at 0 is no vector: it holds no number",
      "the vector of the text at 0 is no vector: its number at 0 is NaN, not a finite number",
      "the vector of the text at 0 is all zeros, which points nowhere",
      "the vector of the text at 1 is 1 numbers long, and the one before it 2",
      "the vector of the text at 0 is 2 numbers long, not the 3 asked for",
    ])
  })

  test("the usage the charge settles at: the input tokens and the bill, as a number or as text; none when it says neither", () => {
    expect(reportedOf({ prompt_tokens: 12, total_tokens: 12, cost: 0.5 })).toEqual(Option.some({ input: 12, output: 0, cacheRead: 0, cacheWrite: 0, billed: 0.5 }))
    expect(reportedOf({ total_tokens: 7 })).toEqual(Option.some({ input: 7, output: 0, cacheRead: 0, cacheWrite: 0, billed: undefined }))
    expect(reportedOf({})).toEqual(Option.none())
    expect(reportedOf(null)).toEqual(Option.none())
    expect(batchesOf([1, 2, 3], 2)).toEqual([[1, 2], [3]])
  })
})

const refuse = (status: number, body: string) => () => new Response(body, { status, headers: { "content-type": "application/json" } })

describe("the embedder's failures", () => {
  test("each refusal of the provider is EmbedFailed in words, its cause the AiError that says whether another try is worth it", async () => {
    const rows = await Promise.all([
      [401, "{\"error\":{\"message\":\"Invalid API key\"}}"],
      [402, "{\"error\":{\"message\":\"no credit\"}}"],
      [429, "{\"error\":{\"message\":\"slow down\"}}"],
      [500, "{\"error\":{\"message\":\"the model is down\"}}"],
      [400, "{\"error\":{\"message\":\"input too long\"}}"],
    ].map(async ([status, body]) => failureOf((await over(fakeFetch(refuse(Number(status), String(body))).fetch, options(), embedded(TEXTS))).outcome)))
    expect(rows).toEqual([
      ["EmbedFailed", "AuthenticationError", false, `The texts were not embedded by ${MODEL}: Invalid API key`],
      ["EmbedFailed", "QuotaExhaustedError", false, `The texts were not embedded by ${MODEL}: Quota exhausted. Check your account billing and usage limits.`],
      ["EmbedFailed", "RateLimitError", true, `The texts were not embedded by ${MODEL}: Rate limit exceeded`],
      ["EmbedFailed", "InternalProviderError", true, `The texts were not embedded by ${MODEL}: the model is down`],
      ["EmbedFailed", "InvalidRequestError", false, `The texts were not embedded by ${MODEL}: input too long`],
    ])
  })

  test("an answer that is no list of embeddings, or one that gives too few vectors or of another length than asked, fails the call", async () => {
    const garbled = await over(fakeFetch(() => new Response("<html>", { status: 200 })).fetch, options(), embedded(TEXTS))
    const short = await over(fakeFetch((sent) => embeddings({ ...sent, body: { ...sent.body, input: sent.body.input.slice(1) } })).fetch, options(), embedded(TEXTS))
    const other = await over(fakeFetch((sent) => embeddings({ ...sent, body: { ...sent.body, dimensions: 4 } })).fetch, options({ dimensions: 8 }), embedded(TEXTS))
    expect([garbled, short, other].map((run) => failureOf(run.outcome))).toEqual([
      ["EmbedFailed", "InvalidOutputError", true, `The texts were not embedded by ${MODEL}: the provider's answer is no list of embeddings`],
      ["EmbedFailed", "InvalidOutputError", true, `The texts were not embedded by ${MODEL}: the provider gave 2 vectors for 3 texts`],
      ["EmbedFailed", "InvalidOutputError", true, `The texts were not embedded by ${MODEL} dimensions=8: the vector of the text at 0 is 4 numbers long, not the 8 asked for`],
    ])
    // An answer that came back whole is settled at what it billed, even when its vectors are refused.
    expect(short.totals).toEqual({ settled: 0.0000012, reserved: 0 })
  })

  test("a connection refused before the request left is a lost connection, worth another try, and holds nothing", async () => {
    const run = await over(fakeFetch(() => Promise.reject(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }))).fetch, options(), embedded(TEXTS))
    expect(failureOf(run.outcome).slice(0, 3)).toEqual(["EmbedFailed", "NetworkError", true])
    expect(run.totals).toEqual({ settled: 0, reserved: 0 })
  })

  test("a body that does not come whole within the idle timeout fails the call as a lost connection, settled at the hold", async () => {
    const hanging = () => new Response(new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode("{\"data\":[")) }), { status: 200 })
    const run = await over(fakeFetch(hanging).fetch, options({ timeouts: { idle: "20 millis" } }), embedded(["ab"]))
    expect(failureOf(run.outcome).slice(0, 3)).toEqual(["EmbedFailed", "NetworkError", true])
    expect(run.totals.settled).toBeGreaterThan(0)
  })

  test("a refusal whose body cannot be read is the provider's refusal by its status, and releases", async () => {
    const broken = () => new Response(new ReadableStream({ start: (controller) => controller.error(new Error("reset")) }), { status: 401 })
    const run = await over(fakeFetch(broken).fetch, options(), embedded(["ab"]))
    expect(failureOf(run.outcome)).toEqual(["EmbedFailed", "AuthenticationError", false, `The texts were not embedded by ${MODEL}: the provider answered 401`])
    expect(run.totals).toEqual({ settled: 0, reserved: 0 })
  })

  test("headers that do not come within the response timeout fail the call as a lost connection, settled at the hold", async () => {
    const run = await over(fakeFetch(() => new Promise<Response>(() => {})).fetch, options({ timeouts: { response: "20 millis" } }), embedded(["ab"]))
    expect(failureOf(run.outcome).slice(0, 3)).toEqual(["EmbedFailed", "NetworkError", true])
    expect(run.totals.settled).toBeGreaterThan(0)
  })
})

describe("the embedder's batches, each a call of its own", () => {
  test("a later batch refused fails the call, sends no batch after it, and leaves the batches before it settled; the span keeps their tokens", async () => {
    const { spans, tracer } = recording()
    let request = 0
    const { fetch, sent } = fakeFetch((one) => (++request === 2 ? refuse(400, "{\"error\":{\"message\":\"too long\"}}")() : embeddings(one, { prompt_tokens: 4 })))
    const run = await over(fetch, options({ batch: 2 }), embedded(["ab", "cd", "ef", "gh", "ij"]).pipe(Effect.withTracer(tracer)))
    expect(failureOf(run.outcome)).toEqual(["EmbedFailed", "InvalidRequestError", false, `The texts were not embedded by ${MODEL}: too long`])
    expect(sent.map((one) => one.body.input)).toEqual([["ab", "cd"], ["ef", "gh"]])
    // The first batch is settled at its usage at the price; the refused one is released.
    expect(run.totals).toEqual({ settled: 4 * price.input / 1_000_000, reserved: 0 })
    const [span] = spans.filter((one) => one.name === "openai_compatible_embedder.embed")
    expect(span?.attributes.get("gen_ai.usage.input_tokens")).toBe(4)
  })
})

describe("the embedder's charge", () => {
  test("a call over the ledger's cap is refused before it is sent: EmbedFailed whose cause is the ledger's refusal, which isSpendRefusal reads", async () => {
    const { fetch, sent } = fakeFetch()
    const run = await over(fetch, options({ spend: { ...priced, caps: { total: 0.000000001 } } }), embedded(TEXTS))
    expect(sent).toEqual([])
    expect(run.totals).toEqual({ settled: 0, reserved: 0 })
    const failure = run.outcome._tag === "Failure" ? run.outcome.failure : undefined
    expect(failureOf(run.outcome)[0]).toBe("EmbedFailed")
    expect(isSpendRefusal(failure)).toBe(true)
    expect(Option.map(spendRefusalOf(failure), (refusal) => [refusal._tag, refusal.reason])).toEqual(Option.some(["ModelSpendExceeded", "total"]))
    // Every other failure is no refusal of the ledger.
    const refused = await over(fakeFetch(refuse(400, "{}")).fetch, options(), embedded(TEXTS))
    expect(isSpendRefusal(refused.outcome._tag === "Failure" ? refused.outcome.failure : undefined)).toBe(false)
  })

  test("a model with no price is refused before anything is sent, and is no refusal of the ledger", async () => {
    const { fetch, sent } = fakeFetch()
    const run = await over(fetch, options({ spend: { prices: {} } }), embedded(TEXTS))
    expect(sent).toEqual([])
    expect(failureOf(run.outcome)).toEqual(["EmbedFailed", "InvalidRequestError", false, `The texts were not embedded by ${MODEL}: the model ${MODEL} has no price, so what a call to it costs cannot be held; give it a price, or mark it uncapped`])
    expect(isSpendRefusal(run.outcome._tag === "Failure" ? run.outcome.failure : undefined)).toBe(false)
  })

  test("holds the body's bytes as input at the input price, nothing for output, and settles at the bill, else the usage at the price, else the hold; a refusal releases", async () => {
    const settled = async (answer: Answer) => {
      let held = 0
      const run = await Effect.runPromise(Effect.gen(function* () {
        const spend = yield* ModelSpend
        const reserving = ModelSpend.of({ ...spend, reserve: (reservation) => { held = reservation.amount; return spend.reserve(reservation) } })
        yield* Effect.result(embedded(["hello"]).pipe(Effect.provide(openAiCompatibleEmbedder(options()).pipe(Layer.provide(Layer.succeed(ModelSpend, reserving))))))
        return (yield* spend.totals).settled
      }).pipe(Effect.provide(modelSpendMemory), Effect.provideService(FetchHttpClient.Fetch, fakeFetch(answer).fetch)))
      return { run, held }
    }
    const body = JSON.stringify({ model: MODEL, input: ["hello"] })
    const bill = await settled((sent) => embeddings(sent))
    const usage = await settled((sent) => embeddings(sent, { prompt_tokens: 1000 }))
    const cut = await settled(() => new Response("{\"data\":[", { status: 500 }))
    const refused = await settled(refuse(400, "{}"))
    expect(bill.held).toBe(new TextEncoder().encode(body).length * price.input / 1_000_000)
    expect([bill.run, usage.run, cut.run, refused.run]).toEqual([0.0000012, 1000 * price.input / 1_000_000, bill.held, 0])
  })
})

/** A tracer that keeps every span it opens. */
const recording = () => {
  const spans: Array<Tracer.Span> = []
  const tracer = Tracer.make({ span: (span) => {
    const made = new Tracer.NativeSpan(span)
    spans.push(made)
    return made
  } })
  return { spans, tracer }
}

describe("the embedder's span and counts", () => {
  test("each embed is a client span with the gen_ai attributes of an embeddings call, the input tokens summed over its requests, and no text", async () => {
    const { spans, tracer } = recording()
    const { fetch } = fakeFetch()
    await over(fetch, options({ batch: 2, dimensions: 8, provider: "vercel.ai_gateway" }), embedded(["ab", "cd", "ef"]).pipe(Effect.withTracer(tracer)))
    const [span] = spans.filter((one) => one.name === "openai_compatible_embedder.embed")
    expect(span?.kind).toBe("client")
    expect(span?.status._tag).toBe("Ended")
    expect(Object.fromEntries(span!.attributes)).toEqual({
      "gen_ai.operation.name": "embeddings",
      "gen_ai.provider.name": "vercel.ai_gateway",
      "gen_ai.request.model": MODEL,
      "gen_ai.embeddings.dimension.count": 8,
      "gen_ai.usage.input_tokens": 6,
    })
  })

  test("each request is counted by the charge as a model call: by how it ended, its input tokens, its cost with the basis", async () => {
    const registry = new Map()
    const run = (answer: Answer) => Effect.runPromise(Effect.result(embedded(["ab", "cd", "ef"])).pipe(
      Effect.provide(openAiCompatibleEmbedder(options({ batch: 2 })).pipe(Layer.provideMerge(modelSpendMemory))),
      Effect.provideService(FetchHttpClient.Fetch, fakeFetch(answer).fetch),
      Effect.provideService(Metric.MetricRegistry, registry),
    ))
    await run((sent) => embeddings(sent))
    await run((sent) => embeddings(sent, { prompt_tokens: 100 }))
    await run(refuse(400, "{}"))
    const count = (metric: typeof modelCalls, attributes: Record<string, string>) => Effect.map(Metric.value(Metric.withAttributes(metric, attributes)), (state) => state.count)
    const counts = await Effect.runPromise(Effect.gen(function* () {
      return {
        calls: yield* Effect.forEach(["answered", "refused"], (outcome) => count(modelCalls, { "efferent.model": MODEL, "efferent.outcome": outcome })),
        tokens: yield* Effect.forEach(["input", "output"], (kind) => count(modelTokens, { "efferent.model": MODEL, "efferent.token.kind": kind })),
        cost: yield* Effect.forEach(["billed", "usage", "held"], (basis) => count(modelCost, { "efferent.model": MODEL, "efferent.cost.basis": basis })),
      }
    }).pipe(Effect.provideService(Metric.MetricRegistry, registry)))
    // Two requests answered in each of the first two embeds; the third embed's first request refused, so it sent no second.
    expect(counts.calls).toEqual([4, 1])
    expect(counts.tokens).toEqual([4 + 2 + 100 + 100, 0])
    expect(counts.cost).toEqual([2 * 0.0000012, 2 * 100 * price.input / 1_000_000, 0])
  })
})

const MARK = { text: "MARKTEXT5e1", refusal: "MARKREFUSAL7c2", key: "MARKKEY3a9" } as const

/** One embed exported to a local collector, the provider answering it, or refusing it with the request echoed. */
const exported = (refuses: boolean, content: boolean) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const posts: Array<string> = []
  const collector = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => { posts.push(await request.text()); return Response.json({}) } })
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const body = await request.text()
    return refuses
      ? new Response(JSON.stringify({ error: { message: `bad request ${MARK.refusal}: ${body}` } }), { status: 400, headers: { "content-type": "application/json" } })
      : embeddings({ url: request.url, headers: request.headers, body: JSON.parse(body) })
  } })
  yield* Effect.addFinalizer(() => Effect.promise(() => Promise.all([collector.stop(true), provider.stop(true)])))
  const exit = yield* embedded([`a note ${MARK.text}`]).pipe(
    Effect.provide(openAiCompatibleEmbedder({ model: MODEL, baseUrl: `http://127.0.0.1:${provider.port}/v1`, apiKey: Redacted.make(MARK.key), spend: priced }).pipe(Layer.provideMerge(modelSpendMemory))),
    Effect.exit,
    Effect.tap(() => flushTelemetry),
    Effect.provide(otlpTelemetry({ baseUrl: `http://127.0.0.1:${collector.port}`, protocol: "http/json", exportInterval: "1 hour", content })),
    Effect.provideService(Metric.MetricRegistry, new Map()),
  )
  return { exit, posted: posts.join("\n") }
})))

const found = (posted: string) => Object.entries(MARK).filter(([, marker]) => posted.includes(marker)).map(([name]) => name)

describe("with content off, no text an embedder embeds leaves the process", () => {
  test("an embed that goes well, and one the provider refuses with the request echoed: the span and the counts are sent, no marker", async () => {
    const well = await exported(false, false)
    const refused = await exported(true, false)
    expect([well.exit._tag, refused.exit._tag]).toEqual(["Success", "Failure"])
    for (const part of ["resourceSpans", "openai_compatible_embedder.embed", "efferent.model.calls", "efferent.model.cost"]) expect(well.posted).toContain(part)
    for (const part of ["resourceSpans", "\"exception\"", "EmbedFailed", "efferent.model.calls", "\"refused\""]) expect(refused.posted).toContain(part)
    expect([found(well.posted), found(refused.posted)]).toEqual([[], []])
  }, 30_000)

  test("with content on, a failure's words are kept: the echoed text and the provider's own", async () => {
    const refused = await exported(true, true)
    expect(found(refused.posted).toSorted()).toEqual(["refusal", "text"])
  }, 30_000)
})
