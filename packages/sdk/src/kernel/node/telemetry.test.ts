import { describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Layer, Metric, Option, Redacted, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { kernel, ModelSpend, modelSpendMemory, Sessions, userMessage } from "@xandreed/core/kernel"
import type { SessionId } from "@xandreed/core/kernel"
import { callTool, curate, CurationFailed, Curator, flatMemory, inProcessJournal, knowledgeSession, Memory, modelAnswer, scriptedModel, sessions } from "../index.js"
import { flushTelemetry, openAiCompatibleModel, otlpTelemetry, otlpTelemetryFromEnv } from "./index.js"
import type { OtlpTelemetryOptions } from "./index.js"

/* ── a collector: Bun.serve keeping every OTLP post ── */

interface Post { readonly path: string; readonly body: string }

const collector = Effect.acquireRelease(
  Effect.sync(() => {
    const posts: Array<Post> = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        posts.push({ path: new URL(request.url).pathname, body: await request.text() })
        return Response.json({})
      },
    })
    return { url: `http://127.0.0.1:${server.port}`, posts, server }
  }),
  ({ server }) => Effect.promise(() => server.stop(true)),
)

/* ── a model: Bun.serve answering as an OpenAI-compatible chat-completions stream, one answer per request ── */

const sse = (chunks: ReadonlyArray<unknown>) => `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`
const ASKS_ADD = sse([
  { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "add", arguments: "{\"a\": 2, \"b\": 3}" } }] }, finish_reason: "tool_calls" }] },
  { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 } } },
])
const ANSWERS = sse([
  { choices: [{ delta: { content: "It is 5." }, finish_reason: "stop" }] },
  { choices: [], usage: { prompt_tokens: 150, completion_tokens: 5 } },
])

const modelServer = (answers: ReadonlyArray<string>) => Effect.acquireRelease(
  Effect.sync(() => {
    const asked: Array<unknown> = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        asked.push(await request.json())
        return new Response(answers[Math.min(asked.length - 1, answers.length - 1)], { headers: { "content-type": "text/event-stream" } })
      },
    })
    return { url: `http://127.0.0.1:${server.port}/v1`, asked, server }
  }),
  ({ server }) => Effect.promise(() => server.stop(true)),
)

const MODEL = "small-model"
const PRICE = { input: 1, output: 4, cacheRead: 0.5 }

/* ── the host's turn: its own loop over the kernel's two functions ── */

const Add = Tool.make("add", { description: "Add two numbers.", parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }), success: Schema.Number })
const tools = Toolkit.make(Add)
const toolsLive = tools.toLayer({ add: ({ a, b }) => Effect.succeed(a + b) })

const hostTurn = (conversation: SessionId, message: string) => Effect.gen(function* () {
  const all = yield* Sessions
  const memory = yield* Memory
  const toolkit = yield* tools
  return yield* all.turn(conversation, (session) => Effect.gen(function* () {
    yield* session.append(userMessage(message))
    for (let step = 1; step <= 3; step++) {
      const history = yield* memory.context(session)
      const answer = yield* modelAnswer(LanguageModel.streamText({
        prompt: Prompt.make([{ role: "system", content: "Add with the tool." }, ...history]), toolkit: tools, disableToolCallResolution: true,
      }), session)
      if (answer.toolCalls.length === 0) return answer.text
      for (const call of answer.toolCalls) yield* callTool(toolkit, call, session)
    }
    return "stopped"
  }))
})

const stackOver = (url: string) => flatMemory.pipe(
  Layer.provideMerge(sessions()),
  Layer.provideMerge(inProcessJournal()),
  Layer.provideMerge(kernel()),
  Layer.provideMerge(toolsLive),
  Layer.provideMerge(openAiCompatibleModel({ model: MODEL, baseUrl: url, apiKey: Redacted.make("model-key"), maxOutputTokens: 100, spend: { prices: { [MODEL]: PRICE } } })),
  Layer.provideMerge(modelSpendMemory),
)

/* ── reading OTLP/JSON ── */

interface KeyValue { readonly key: string; readonly value: Readonly<Record<string, unknown>> }
interface JsonSpan {
  readonly name: string
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId?: string
  readonly attributes: ReadonlyArray<KeyValue>
  readonly events?: ReadonlyArray<{ readonly name: string; readonly attributes: ReadonlyArray<KeyValue> }>
}

const valueOf = (value: Readonly<Record<string, unknown>>): unknown => value.stringValue ?? value.intValue ?? value.doubleValue ?? value.boolValue
const attributesOf = (list: ReadonlyArray<KeyValue>): Record<string, unknown> => Object.fromEntries(list.map((entry) => [entry.key, valueOf(entry.value)]))
const spansOf = (posts: ReadonlyArray<Post>): ReadonlyArray<JsonSpan> => posts.filter((post) => post.path === "/v1/traces").flatMap((post) =>
  (JSON.parse(post.body) as { readonly resourceSpans: ReadonlyArray<{ readonly scopeSpans: ReadonlyArray<{ readonly spans: ReadonlyArray<JsonSpan> }> }> })
    .resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)))

// #region telemetry
/**
 * A host's program, traced and measured: the spans and metrics of every turn it runs, posted over OTLP/HTTP to the
 * collector the standard OTEL_* variables name (none named, nothing sent), with what was said left out. The last
 * batch is posted before the program returns; a failed post never fails it.
 */
const observed = <A, E, R>(program: Effect.Effect<A, E, R>) => program.pipe(
  Effect.tap(() => flushTelemetry),
  Effect.provide(otlpTelemetryFromEnv({ serviceName: "my-agent" })),
)
// #endregion telemetry

interface JsonPoint { readonly attributes: ReadonlyArray<KeyValue>; readonly asDouble?: number; readonly asInt?: number | string }
interface JsonMetric { readonly name: string; readonly sum?: { readonly dataPoints: ReadonlyArray<JsonPoint> } }

/** The last export of each metric (exports are cumulative), its points as attributes and value. */
const metricsOf = (posts: ReadonlyArray<Post>): Record<string, ReadonlyArray<{ readonly attributes: Record<string, unknown>; readonly value: number }>> => {
  const last = posts.filter((post) => post.path === "/v1/metrics").at(-1)
  const metrics = last === undefined ? [] : (JSON.parse(last.body) as { readonly resourceMetrics: ReadonlyArray<{ readonly scopeMetrics: ReadonlyArray<{ readonly metrics: ReadonlyArray<JsonMetric> }> }> })
    .resourceMetrics.flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics))
  return Object.fromEntries(metrics.map((metric) => [metric.name, (metric.sum?.dataPoints ?? []).map((point) => ({ attributes: attributesOf(point.attributes), value: Number(point.asDouble ?? point.asInt) }))]))
}

const named = (spans: ReadonlyArray<JsonSpan>, name: string): ReadonlyArray<JsonSpan> => spans.filter((span) => span.name === name)
const childrenOf = (spans: ReadonlyArray<JsonSpan>, parent: JsonSpan): ReadonlyArray<string> =>
  spans.filter((span) => span.parentSpanId === parent.spanId).map((span) => span.name)
const isRoot = (span: JsonSpan): boolean => span.parentSpanId === undefined || span.parentSpanId === ""

/** The attributes that hold what was said, which the export leaves out unless content is on. */
const CONTENT = ["parameters", "gen_ai.system_instructions", "gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.tool.call.arguments", "gen_ai.tool.call.result"]
const contentOf = (spans: ReadonlyArray<JsonSpan>): ReadonlyArray<string> => spans.flatMap((span) => span.attributes.map((entry) => entry.key).filter((key) => CONTENT.includes(key)).map((key) => `${span.name} ${key}`))

/**
 * `program` over the stock parts and a model server answering `answers`, under the export to a local collector with
 * `options`, then a flush: what the collector received, what the model was asked, and the program's result.
 */
const exported = <A, E>(
  options: Partial<OtlpTelemetryOptions>,
  program: Effect.Effect<A, E, Sessions | Memory | ModelSpend | LanguageModel.LanguageModel | Tool.HandlersFor<typeof tools.tools>>,
  answers: ReadonlyArray<string> = [ASKS_ADD, ANSWERS],
) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const { url, posts } = yield* collector
  const model = yield* modelServer(answers)
  const result = yield* program.pipe(
    Effect.provide(stackOver(model.url)),
    Effect.tap(() => flushTelemetry),
    Effect.provide(otlpTelemetry({ baseUrl: url, protocol: "http/json", exportInterval: "1 hour", ...options })),
    // One registry for the program and the exporter, apart from other tests'.
    Effect.provideService(Metric.MetricRegistry, new Map()),
  )
  return { result, posts: [...posts], asked: [...model.asked] }
})))

/** A conversation and one host turn in it: what 2 + 3 is, the model asking `add` first. */
const askAdd = Effect.gen(function* () {
  const conversation = yield* (yield* Sessions).create({ owner: "host" })
  const reply = yield* hostTurn(conversation, "What is 2 + 3?")
  return { conversation, reply, totals: yield* (yield* ModelSpend).totals }
})

describe("a kernel host's turn, exported over OTLP", () => {
  test("the span tree a host gets without writing a span: the turn, each model call with its gen_ai attributes, the tool call", async () => {
    const run = await exported({}, askAdd)
    expect(run.result.reply).toBe("It is 5.")
    const spans = spansOf(run.posts)
    const [turn] = named(spans, "kernel.turn")
    expect(turn).toBeDefined()
    expect(isRoot(turn!)).toBe(true)
    expect(new Set(spans.map((span) => span.traceId)).size).toBe(1)
    expect(attributesOf(turn!.attributes)).toEqual({
      "efferent.session.id": run.result.conversation,
      "gen_ai.conversation.id": run.result.conversation,
      "efferent.turn": 1,
      "efferent.outcome": "completed",
    })
    // Under the turn, in the order they started: its begin, each step's memory, model call and the model's HTTP
    // request (Effect AI's stream span is not the request's parent), the tool call between the two steps, its end.
    expect(childrenOf(spans, turn!)).toEqual([
      "kernel.session.begin",
      "kernel.flat.context", "POST", "LanguageModel.streamText",
      "kernel.tool.call",
      "kernel.flat.context", "POST", "LanguageModel.streamText",
      "kernel.session.end",
    ])
    const [asked, answered] = named(spans, "LanguageModel.streamText").map((span) => attributesOf(span.attributes))
    expect(asked).toMatchObject({
      "gen_ai.provider.name": "openai",
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": MODEL,
      "gen_ai.request.max_tokens": 100,
      "gen_ai.response.model": MODEL,
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 10,
      "gen_ai.usage.cache_read.input_tokens": 40,
    })
    expect(answered).toMatchObject({ "gen_ai.usage.input_tokens": 150, "gen_ai.usage.output_tokens": 5 })
    const [tool] = named(spans, "kernel.tool.call")
    expect(attributesOf(tool!.attributes)).toMatchObject({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "add",
      "gen_ai.tool.call.id": "call-1",
      "efferent.outcome": "succeeded",
    })
  })

  test("the metrics: model calls by model and outcome, tokens by kind, the cost the ledger settled, tool calls by tool; none names a session or a turn", async () => {
    const run = await exported({}, askAdd)
    const metrics = metricsOf(run.posts)
    expect(metrics["kernel.model.calls"]).toEqual([{ attributes: { "efferent.model": MODEL, "efferent.outcome": "answered" }, value: 2 }])
    // 100 then 150 read, 40 of the first from the cache; 10 then 5 written.
    expect(metrics["kernel.model.tokens"]).toEqual([
      { attributes: { "efferent.model": MODEL, "efferent.token.kind": "input" }, value: 60 + 150 },
      { attributes: { "efferent.model": MODEL, "efferent.token.kind": "cache_read" }, value: 40 },
      { attributes: { "efferent.model": MODEL, "efferent.token.kind": "output" }, value: 15 },
    ])
    // The cost is what the ledger settled, and nothing else: the two calls at the model's price.
    expect(run.result.totals.settled).toBeCloseTo((60 * 1 + 40 * 0.5 + 10 * 4 + 150 * 1 + 5 * 4) / 1_000_000, 12)
    expect(metrics["kernel.model.cost"]).toEqual([{ attributes: { "efferent.model": MODEL }, value: run.result.totals.settled }])
    expect(metrics["kernel.tool.calls"]).toEqual([{ attributes: { "efferent.tool": "add", "efferent.outcome": "succeeded" }, value: 1 }])
    const keys = Object.values(metrics).flatMap((points) => points.flatMap((point) => Object.keys(point.attributes)))
    expect(keys.filter((key) => ["efferent.session.id", "gen_ai.conversation.id", "efferent.turn"].includes(key))).toEqual([])
  })

  test("content is off by default: no span sent holds a prompt, an answer or a tool's parameters", async () => {
    const run = await exported({}, askAdd)
    expect(contentOf(spansOf(run.posts))).toEqual([])
  })

  test("content on: each model call's span holds its prompt and its answer, a tool's result among the next prompt, and the tool call its parameters", async () => {
    const run = await exported({ content: true }, askAdd)
    const spans = spansOf(run.posts)
    const [first, second] = named(spans, "LanguageModel.streamText").map((span) => attributesOf(span.attributes))
    expect(JSON.parse(String(first!["gen_ai.system_instructions"]))).toEqual([{ type: "text", content: "Add with the tool." }])
    expect(JSON.parse(String(first!["gen_ai.input.messages"]))).toEqual([{ role: "user", parts: [{ type: "text", content: "What is 2 + 3?" }] }])
    expect(JSON.parse(String(first!["gen_ai.output.messages"]))).toEqual([
      { role: "assistant", parts: [{ type: "tool_call", id: "call-1", name: "add", arguments: { a: 2, b: 3 } }], finish_reason: "tool-calls" },
    ])
    expect(JSON.parse(String(second!["gen_ai.input.messages"]))).toEqual([
      { role: "user", parts: [{ type: "text", content: "What is 2 + 3?" }] },
      { role: "assistant", parts: [{ type: "tool_call", id: "call-1", name: "add", arguments: { a: 2, b: 3 } }] },
      { role: "tool", parts: [{ type: "tool_call_response", id: "call-1", response: 5, is_failure: false }] },
    ])
    expect(JSON.parse(String(second!["gen_ai.output.messages"]))).toEqual([{ role: "assistant", parts: [{ type: "text", content: "It is 5." }], finish_reason: "stop" }])
    // Effect AI's toolkit put the parameters on the tool call's span; with content off, the export left them out.
    const [tool] = named(spans, "kernel.tool.call")
    expect(tool!.attributes.map((entry) => entry.key)).toContain("parameters")
  })

  test("a host's policy drops spans and redacts attributes, its children kept under the nearest kept span, beside the content rule", async () => {
    const run = await exported({
      content: true,
      spans: {
        keep: (span) => !span.name.startsWith("kernel.session.") && span.name !== "kernel.flat.context",
        attribute: (_span, key, value) => key === "gen_ai.input.messages" || key === "gen_ai.conversation.id" ? Option.none()
          : key === "efferent.session.id" ? Option.some("redacted") : Option.some(value),
      },
    }, askAdd)
    const spans = spansOf(run.posts)
    const [turn] = named(spans, "kernel.turn")
    expect(childrenOf(spans, turn!)).toEqual(["POST", "LanguageModel.streamText", "kernel.tool.call", "POST", "LanguageModel.streamText"])
    expect(attributesOf(turn!.attributes)).toEqual({ "efferent.session.id": "redacted", "efferent.turn": 1, "efferent.outcome": "completed" })
    expect(contentOf(spans)).toEqual([
      "LanguageModel.streamText gen_ai.system_instructions", "LanguageModel.streamText gen_ai.output.messages",
      "kernel.tool.call parameters",
      "LanguageModel.streamText gen_ai.system_instructions", "LanguageModel.streamText gen_ai.output.messages",
    ])
  })
})

/** `program` over the stock parts and a model server answering 2 + 3, under the export `options` describe, then a flush. */
const underExport = <A, E>(
  options: OtlpTelemetryOptions,
  program: Effect.Effect<A, E, Sessions | Memory | ModelSpend | LanguageModel.LanguageModel | Tool.HandlersFor<typeof tools.tools>>,
) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const model = yield* modelServer([ASKS_ADD, ANSWERS])
  const result = yield* program.pipe(Effect.provide(stackOver(model.url)), Effect.tap(() => flushTelemetry), Effect.provide(otlpTelemetry(options)), Effect.provideService(Metric.MetricRegistry, new Map()))
  return { result, asked: [...model.asked] }
})))

describe("an export that fails", () => {
  // Effect's exporter tries a failed post three more times, a second apart, before it turns the signal off for a
  // minute: the flush waits for that, and then the program goes on as if nothing had been sent.
  test("never fails the host's program: a collector that is gone, and one that refuses every post", async () => {
    const gone = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) })
    const goneUrl = `http://127.0.0.1:${gone.port}`
    await gone.stop(true)
    const refusing = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("down", { status: 500 }) })
    const replies = []
    for (const baseUrl of [goneUrl, `http://127.0.0.1:${refusing.port}`]) {
      const run = await underExport({ baseUrl, protocol: "http/json", exportInterval: "1 hour", shutdownTimeout: "1 second" }, askAdd)
      replies.push(run.result.reply)
    }
    await refusing.stop(true)
    expect(replies).toEqual(["It is 5.", "It is 5."])
  }, 30_000)
})

describe("with no tracer installed", () => {
  test("nothing a turn stores or sends changes: the same journal and the same requests as under the export", async () => {
    const readBack = Effect.flatMap(askAdd, ({ conversation }) => Effect.map((Sessions).pipe(Effect.flatMap((all) => all.read(conversation))), (journal) =>
      journal.events.map((event) => [event.name, event.turn, event.data])))
    const plain = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const model = yield* modelServer([ASKS_ADD, ANSWERS])
      const result = yield* readBack.pipe(Effect.provide(stackOver(model.url)))
      return { result, asked: [...model.asked] }
    })))
    const traced = await exported({ content: true }, readBack)
    expect(traced.result).toEqual(plain.result)
    expect(traced.asked).toEqual(plain.asked)
  })
})

/** A curator over the host's model: each prompt asked of it, the text of its answer the reply. */
const modelCurator = Layer.effect(Curator, Effect.map(LanguageModel.LanguageModel, (model) => Curator.of({
  curate: ({ prompt }) => model.streamText({ prompt }).pipe(
    Stream.filter((part) => part.type === "text-delta"),
    Stream.map((part) => part.delta),
    Stream.mkString,
    Effect.mapError((error) => new CurationFailed({ message: error.message })),
  ),
})))

const NOTHING_KEPT = "{\"entities\":[],\"aliases\":[],\"memories\":[],\"restates\":[],\"forget\":[]}"

describe("a curation, which runs in no turn", () => {
  test("is a trace of its own: the curator's model calls under knowledge.curate, its root, or under the host's span", async () => {
    const curated = (program: Effect.Effect<unknown, unknown, Sessions | Curator>) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { url, posts } = yield* collector
      const { model } = yield* scriptedModel([{ _tag: "Answers", pieces: [NOTHING_KEPT] }, { _tag: "Answers", pieces: [NOTHING_KEPT] }])
      yield* program.pipe(
        Effect.provide(modelCurator.pipe(Layer.provideMerge(model), Layer.merge(sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel()))))),
        Effect.tap(() => flushTelemetry),
        Effect.provide(otlpTelemetry({ baseUrl: url, protocol: "http/json", exportInterval: "1 hour" })),
        Effect.provideService(Metric.MetricRegistry, new Map()),
      )
      return spansOf([...posts])
    })))
    const keep = Effect.flatMap(knowledgeSession, (session) => curate(session, { said: [{ by: "user", text: "My friend Ana Silva lives in Porto." }], at: Date.parse("2026-11-09T12:00:00Z") }))

    const alone = await curated(keep)
    const [root] = named(alone, "knowledge.curate")
    expect(isRoot(root!)).toBe(true)
    expect(new Set(alone.map((span) => span.traceId)).size).toBe(1)
    // The source stored in a turn, the curator asked outside any turn (extract, then review), what passed stored in another.
    expect(childrenOf(alone, root!).filter((name) => name === "kernel.turn" || name === "LanguageModel.streamText"))
      .toEqual(["kernel.turn", "LanguageModel.streamText", "LanguageModel.streamText", "kernel.turn"])

    const hosted = await curated(keep.pipe(Effect.withSpan("host.after_turn")))
    const [host] = named(hosted, "host.after_turn")
    expect(isRoot(host!)).toBe(true)
    expect(childrenOf(hosted, host!)).toEqual(["knowledge.curate"])
    expect(new Set(hosted.map((span) => span.traceId)).size).toBe(1)
  })
})

describe("a host's program, observed as docs/kernel.md shows it", () => {
  test("exports where the standard variables say, under the host's service name, and nothing when they name no collector", async () => {
    const run = (env: (url: string) => Record<string, string>) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { url, posts } = yield* collector
      const model = yield* modelServer([ASKS_ADD, ANSWERS])
      const result = yield* observed(askAdd.pipe(Effect.provide(stackOver(model.url)))).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: env(url) })),
        Effect.provideService(Metric.MetricRegistry, new Map()),
      )
      return { reply: result.reply, posts: [...posts] }
    })))
    const sent = await run((url) => ({ OTEL_EXPORTER_OTLP_ENDPOINT: url, OTEL_EXPORTER_OTLP_PROTOCOL: "http/json" }))
    expect(sent.reply).toBe("It is 5.")
    expect(new Set(sent.posts.map((post) => post.path))).toEqual(new Set(["/v1/traces", "/v1/metrics"]))
    const resource = (JSON.parse(sent.posts.find((post) => post.path === "/v1/traces")!.body) as { readonly resourceSpans: ReadonlyArray<{ readonly resource: { readonly attributes: ReadonlyArray<KeyValue> } }> }).resourceSpans[0]!.resource
    expect(attributesOf(resource.attributes)["service.name"]).toBe("my-agent")
    expect(named(spansOf(sent.posts), "kernel.turn").length).toBe(1)
    expect(contentOf(spansOf(sent.posts))).toEqual([])

    const silent = await run(() => ({}))
    expect([silent.reply, silent.posts]).toEqual(["It is 5.", []])
  })
})
