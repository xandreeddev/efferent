import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Redacted, Schema, Stream } from "effect"
import type { Tracer } from "effect"
import { LanguageModel } from "effect/ai"
import { HttpClient, HttpClientResponse } from "effect/http"
import { LangSmithTelemetryHttpLive, LangSmithTelemetryLive } from "./langsmith-telemetry.adapter.js"
import { flushTelemetry } from "./otlp-telemetry.adapter.js"
import { LANGSMITH_OPTIONS_ERROR, LANGSMITH_TRACES_URL } from "./langsmith-telemetry.entity.js"
import type { LangSmithTelemetryOptions } from "./langsmith-telemetry.entity.js"

interface Post { readonly path: string; readonly headers: Headers; readonly body: unknown }
interface WireSpan { readonly name: string; readonly parentSpanId?: string; readonly attributes: ReadonlyArray<{ readonly key: string; readonly value: { readonly stringValue?: string; readonly intValue?: string; readonly doubleValue?: number; readonly boolValue?: boolean } }> }
const attrs = (span: WireSpan) => Object.fromEntries(span.attributes.map(({ key, value }) => [key, value.stringValue ?? value.intValue ?? value.doubleValue ?? value.boolValue]))
const spans = (posts: ReadonlyArray<Post>): ReadonlyArray<WireSpan> => posts.flatMap((post) => (post.body as { resourceSpans: { scopeSpans: { spans: WireSpan[] }[] }[] }).resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)))
const collector = Effect.acquireRelease(Effect.sync(() => {
  const posts: Post[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    posts.push({ path: `${new URL(request.url).pathname}${new URL(request.url).search}`, headers: request.headers, body: await request.json() })
    return Response.json({})
  } })
  return { posts, server, url: `http://127.0.0.1:${server.port}` }
}), ({ server }) => Effect.tryPromise(() => server.stop(true)).pipe(Effect.orDie))

const project = { _tag: "Project" as const, project: "collector-project" }
const apiKey = Redacted.make("collector-key")
const finish = { type: "finish" as const, reason: "stop" as const, usage: { inputTokens: { total: 7 }, outputTokens: { total: 2 } } }

describe("LangSmith OTLP layers", () => {
  test("native header values are validated at either layer boundary with no secret-bearing cause", async () => {
    const attempted = { requests: 0 }
    const client = HttpClient.make((request) => Effect.sync(() => { attempted.requests++; return HttpClientResponse.fromWeb(request, Response.json({})) }))
    const layers = [
      (input: LangSmithTelemetryOptions) => LangSmithTelemetryLive(input),
      (input: LangSmithTelemetryOptions) => LangSmithTelemetryHttpLive(input).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
    ]
    const malformed: ReadonlyArray<LangSmithTelemetryOptions> = [
      { apiKey: Redacted.make("collector-secret\u0000value"), target: project },
      { apiKey, target: { _tag: "Project", project: "collector-secret\u0000value" } },
      { apiKey: Redacted.make("collector-secret-\u0100"), target: project },
      { apiKey, target: { _tag: "Project", project: "collector-secret-\u0100" } },
    ]
    await Effect.runPromise(Effect.forEach(layers, (layer) => Effect.forEach(malformed, (input) => Effect.gen(function* () {
      const exit = yield* Effect.exit(Effect.scoped(Layer.build(layer(input))))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "HarnessError", code: "config.options", message: LANGSMITH_OPTIONS_ERROR })
      expect(JSON.stringify(exit)).not.toContain("collector-secret")
    }), { concurrency: 1 }), { concurrency: 1 }))
    expect(attempted.requests).toBe(0)
    await Effect.runPromise(Effect.forEach(layers, (layer) => Effect.forEach([
      { apiKey: Redacted.make("ascii-key"), target: { _tag: "Project" as const, project: "ascii-project" } },
      { apiKey: Redacted.make("cl\u00e9"), target: { _tag: "Project" as const, project: "projet-caf\u00e9" } },
    ], (input) => Effect.succeed("valid headers").pipe(Effect.provide(layer(input)), Effect.tap((value) => Effect.sync(() => expect(value).toBe("valid headers")))), { concurrency: 1 }), { concurrency: 1 }))
  })

  test("actual text/object/stream native operations export once at the exact signal URL through one flusher", async () => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const endpoint = yield* collector
      yield* Effect.gen(function* () {
        const annotate = (span: Tracer.Span) => {
          span.attribute("gen_ai.operation.name", "chat")
          span.attribute("gen_ai.provider.name", "fixture")
          span.attribute("gen_ai.request.model", "requested")
          span.attribute("gen_ai.response.model", "actual")
          span.attribute("gen_ai.usage.input_tokens", 7)
          span.attribute("gen_ai.usage.output_tokens", 2)
        }
        const model = yield* LanguageModel.make({
          generateText: (input) => Effect.sync(() => { annotate(input.span); return [{ type: "text", text: '{"value":3}' }, finish] }),
          streamText: (input) => Stream.fromArray([{ type: "text-start" as const, id: "s" }, { type: "text-delta" as const, id: "s", delta: "stream" }, { type: "text-end" as const, id: "s" }, finish]).pipe(Stream.tap((part) => Effect.sync(() => { if (part.type === "finish") annotate(input.span) }))),
        })
        yield* model.generateText({ prompt: "text" })
        // Object decoding also uses the provider's actual native span.
        yield* model.generateObject({ prompt: "object", schema: Schema.Struct({ value: Schema.Number }) })
        yield* Stream.runDrain(model.streamText({ prompt: "stream" }))
        yield* flushTelemetry
        yield* flushTelemetry
      }).pipe(
        Effect.withSpan("engine.turn", { attributes: { "gen_ai.usage.input_tokens": 21, "llm.cost.total": 3, "engine.usage.input_tokens": 21 } }),
        Effect.provide(LangSmithTelemetryLive({ apiKey, target: project, tracesUrl: `${endpoint.url}/custom/otel/v1/traces?tenant=test`, protocol: "http/json", exportInterval: "1 hour", resourceAttributes: { "service.version": "test" } })),
      )
      return endpoint.posts
    })))
    expect(observed).toHaveLength(2)
    expect(observed.every((post) => post.path === "/custom/otel/v1/traces?tenant=test")).toBe(true)
    expect(observed.every((post) => post.headers.get("x-api-key") === "collector-key" && post.headers.get("Langsmith-Project") === "collector-project" && post.headers.get("Langsmith-Agent-Id") === null)).toBe(true)
    const emitted = spans(observed)
    const llms = emitted.filter((span) => attrs(span)["langsmith.span.kind"] === "llm")
    expect(llms.map((span) => span.name)).toEqual(["LanguageModel.generateText", "LanguageModel.generateObject", "LanguageModel.streamText"])
    expect(llms.reduce((n, span) => n + Number(attrs(span)["gen_ai.usage.input_tokens"]), 0)).toBe(21)
    expect(llms.reduce((n, span) => n + Number(attrs(span)["gen_ai.usage.output_tokens"]), 0)).toBe(6)
    expect(llms.every((span) => attrs(span)["gen_ai.system"] === "fixture" && attrs(span)["gen_ai.response.model"] === "actual")).toBe(true)
    const engine = emitted.find((span) => span.name === "engine.turn")!
    expect(attrs(engine)).toMatchObject({ "langsmith.span.kind": "chain", "engine.usage.input_tokens": 21 })
    expect(attrs(engine)["gen_ai.usage.input_tokens"]).toBeUndefined()
    expect(attrs(engine)["llm.cost.total"]).toBeUndefined()
    const resources = observed.flatMap((post) => (post.body as { resourceSpans: { resource: { attributes: { key: string; value: { stringValue: string } }[] } }[] }).resourceSpans.map((resource) => Object.fromEntries(resource.resource.attributes.map((entry) => [entry.key, entry.value.stringValue]))))
    expect(resources.every((resource) => resource["service.name"] === "efferent" && resource["service.version"] === "test")).toBe(true)
  })

  test("agent addressing sends exactly the paired headers for every environment and no metrics", async () => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const endpoint = yield* collector
      yield* Effect.forEach(["local", "development", "staging", "production"] as const, (environment) => Effect.void.pipe(
        Effect.withSpan("host.event"),
        Effect.provide(LangSmithTelemetryLive({ apiKey, target: { _tag: "Agent", agentId: "collector-agent", environment }, tracesUrl: `${endpoint.url}/otel/v1/traces`, protocol: "http/json", exportInterval: "1 hour" })),
      ), { concurrency: 1 })
      return endpoint.posts
    })))
    expect(observed).toHaveLength(4)
    expect(observed.map((post) => post.headers.get("Langsmith-Agent-Environment"))).toEqual(["local", "development", "staging", "production"])
    expect(observed.every((post) => post.path === "/otel/v1/traces" && post.headers.get("Langsmith-Agent-Id") === "collector-agent" && post.headers.get("Langsmith-Project") === null)).toBe(true)
  })

  test("HttpLive uses the complete default endpoint and exporter failures cannot fail host work", async () => {
    const requests: string[] = []
    const client = HttpClient.make((request, url) => Effect.sync(() => {
      requests.push(url.toString())
      return HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }))
    }))
    const result = await Effect.runPromise(Effect.scoped(Effect.succeed("host completed").pipe(
      Effect.withSpan("agent.turn"),
      Effect.provide(LangSmithTelemetryHttpLive({ apiKey, target: project, protocol: "http/json", exportInterval: "1 hour", shutdownTimeout: "5 millis" }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)))),
    )))
    expect(result).toBe("host completed")
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every((url) => url === LANGSMITH_TRACES_URL)).toBe(true)
  })
})
