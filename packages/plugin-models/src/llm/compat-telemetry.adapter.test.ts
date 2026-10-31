import { expect, test } from "bun:test"
import { Effect, Schema, Stream, Tracer } from "effect"
import { makeCompatLanguageModel } from "./compat.js"

const config = { moduleName: "compat-fixture", model: "selected-model", chatUrl: "https://models.invalid/chat/completions" }
const completed = (usage?: unknown, content = "done") => ({ choices: [{ finish_reason: "stop", message: { content } }], ...(usage === undefined ? {} : { usage }) })
const native = (spans: ReadonlyArray<Tracer.NativeSpan>) => spans.filter((span) => ["LanguageModel.generateText", "LanguageModel.generateObject", "LanguageModel.streamText"].includes(span.name))
const capture = <A, E>(program: Effect.Effect<A, E>) => {
  const spans: Tracer.NativeSpan[] = []
  const tracer = Tracer.make({ span: (options) => { const span = new Tracer.NativeSpan(options); spans.push(span); return span } })
  return Effect.runPromise(program.pipe(Effect.withTracer(tracer), Effect.exit, Effect.map((exit) => ({ exit, spans: native(spans) }))))
}
const usageOf = (span: Tracer.NativeSpan) => Object.fromEntries([...span.attributes].filter(([name]) => name.startsWith("gen_ai.usage.")))
const sse = (...chunks: ReadonlyArray<unknown>) => chunks.map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`).join("")

test.each([
  [{ prompt_tokens: 7, completion_tokens: 2 }, { "gen_ai.usage.input_tokens": 7, "gen_ai.usage.output_tokens": 2 }],
  [undefined, {}],
  [{ prompt_tokens: 0, completion_tokens: 0 }, { "gen_ai.usage.input_tokens": 0, "gen_ai.usage.output_tokens": 0 }],
  [{ prompt_tokens: 7 }, { "gen_ai.usage.input_tokens": 7 }],
  [{ prompt_tokens: 7, completion_tokens: -1 }, {}],
] as const)("native settled compat telemetry preserves raw usage presence (%j)", async (usage, expected) => {
  const found = await capture(Effect.gen(function* () {
    const model = yield* makeCompatLanguageModel({ ...config, fetchImpl: async () => Response.json(completed(usage)) })
    return yield* model.generateText({ prompt: "inspect raw usage" })
  }))
  expect(found.spans).toHaveLength(1)
  expect(Object.fromEntries(found.spans[0]!.attributes)).toMatchObject({ "gen_ai.provider.name": config.moduleName, "gen_ai.request.model": config.model, "gen_ai.operation.name": "chat" })
  expect(usageOf(found.spans[0]!)).toEqual(expected)
  expect(found.spans[0]!.attributes.has("gen_ai.response.model")).toBe(false)
})

test("native object calls annotate only their actual raw cache/reasoning counters", async () => {
  const found = await capture(Effect.gen(function* () {
    const model = yield* makeCompatLanguageModel({ ...config, fetchImpl: async () => Response.json(completed({
      prompt_tokens: 9, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 },
    }, '{"ok":true}')) })
    return yield* model.generateObject({ prompt: "return an object", schema: Schema.Struct({ ok: Schema.Boolean }) })
  }))
  expect(found.spans.map((span) => span.name)).toEqual(["LanguageModel.generateObject"])
  expect(usageOf(found.spans[0]!)).toEqual({ "gen_ai.usage.input_tokens": 9, "gen_ai.usage.output_tokens": 3,
    "gen_ai.usage.cache_read.input_tokens": 4, "gen_ai.usage.cache_write.input_tokens": 2, "gen_ai.usage.reasoning.output_tokens": 1 })
})

test("a host's settled response replacement cannot replace native physical usage", async () => {
  const found = await capture(Effect.gen(function* () {
    const model = yield* makeCompatLanguageModel({ ...config, fetchImpl: async () => Response.json(completed({ prompt_tokens: 7, completion_tokens: 2 })),
      aroundRequest: (_body, request) => request.pipe(Effect.as(Response.json(completed({ prompt_tokens: 100, completion_tokens: 50 }, "host replacement")))),
    })
    return yield* model.generateText({ prompt: "inspect physical usage" })
  }))
  expect(usageOf(found.spans[0]!)).toEqual({ "gen_ai.usage.input_tokens": 7, "gen_ai.usage.output_tokens": 2 })
})

test("streamed counters replace cumulative snapshots without buffering visible deltas or publishing an initial output zero", async () => {
  const spans: Tracer.NativeSpan[] = []
  const tracer = Tracer.make({ span: (options) => { const span = new Tracer.NativeSpan(options); spans.push(span); return span } })
  const channel: { controller?: ReadableStreamDefaultController<Uint8Array> } = {}
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    channel.controller = controller
    controller.enqueue(encoder.encode(sse({ choices: [{ delta: { content: "early" } }], usage: { prompt_tokens: 4, completion_tokens: 0 } })))
  } })
  const seen: string[] = []
  await Effect.runPromise(Effect.gen(function* () {
    const model = yield* makeCompatLanguageModel({ ...config, fetchImpl: async () => new Response(body) })
    yield* model.streamText({ prompt: "stream usage" }).pipe(Stream.tap((part) => Effect.sync(() => {
      if (part.type !== "text-delta") return
      seen.push(part.delta)
      const span = native(spans)[0]!
      expect(span.attributes.get("gen_ai.usage.input_tokens")).toBe(4)
      expect(span.attributes.has("gen_ai.usage.output_tokens")).toBe(false)
      channel.controller?.enqueue(encoder.encode(sse({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 2 } }, "[DONE]")))
      channel.controller?.close()
    })), Stream.runDrain)
  }).pipe(Effect.withTracer(tracer), Effect.timeout("2 seconds")))
  expect(seen).toEqual(["early"])
  expect(usageOf(native(spans)[0]!)).toEqual({ "gen_ai.usage.input_tokens": 7, "gen_ai.usage.output_tokens": 2 })
})

test.each([
  [{ choices: [{ delta: { content: "partial" } }], usage: { prompt_tokens: 7, completion_tokens: 0 } }, { "gen_ai.usage.input_tokens": 7 }],
  [{ choices: [{ delta: { content: "zero" }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0 } }, { "gen_ai.usage.input_tokens": 0, "gen_ai.usage.output_tokens": 0 }],
  [{ choices: [{ delta: { content: "unknown" }, finish_reason: "stop" }] }, {}],
] as const)("native streams retain finality and missing-usage semantics (%j)", async (chunk, expected) => {
  const found = await capture(Effect.gen(function* () {
    const model = yield* makeCompatLanguageModel({ ...config, fetchImpl: async () => new Response(sse(chunk, "[DONE]")) })
    yield* Stream.runDrain(model.streamText({ prompt: "stream coverage" }))
  }))
  expect(found.spans).toHaveLength(1)
  expect(usageOf(found.spans[0]!)).toEqual(expected)
})

test("a failed stream does not promote its initial output zero to final usage", async () => {
  const channel: { controller?: ReadableStreamDefaultController<Uint8Array> } = {}
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    channel.controller = controller
    controller.enqueue(new TextEncoder().encode(sse({ choices: [{ delta: { content: "partial" } }], usage: { prompt_tokens: 7, completion_tokens: 0 } })))
  } })
  const found = await capture(Effect.gen(function* () {
    const model = yield* makeCompatLanguageModel({ ...config, fetchImpl: async () => new Response(body) })
    yield* model.streamText({ prompt: "inspect failed stream usage" }).pipe(Stream.tap((part) => Effect.sync(() => {
      if (part.type === "text-delta") channel.controller?.error(new Error("scripted stream failure"))
    })), Stream.runDrain)
  }).pipe(Effect.timeout("2 seconds")))
  expect(found.exit._tag).toBe("Failure")
  expect(usageOf(found.spans[0]!)).toEqual({ "gen_ai.usage.input_tokens": 7 })
})
