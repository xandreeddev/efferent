import { describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Exit, Layer, Metric } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { flushTelemetry, OtlpTelemetryFromEnv, OtlpTelemetryHttpFromEnv, OtlpTelemetryLive } from "./otlp-telemetry.adapter.js"
import { MODEL, PRICE, scriptedTurn } from "./scripted-turn.testing.js"

/* ── a collector: Bun.serve keeping every OTLP post ── */

interface Post {
  readonly path: string
  readonly contentType: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array
}

const collector = Effect.acquireRelease(
  Effect.sync(() => {
    const posts: Array<Post> = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const headers: Record<string, string> = {}
        request.headers.forEach((value, key) => { headers[key] = value })
        posts.push({
          path: new URL(request.url).pathname,
          contentType: request.headers.get("content-type") ?? "",
          headers,
          body: new Uint8Array(await request.arrayBuffer()),
        })
        return Response.json({})
      },
    })
    return { url: `http://127.0.0.1:${server.port}`, posts, server }
  }),
  ({ server }) => Effect.promise(() => server.stop(true)),
)

/* ── reading OTLP/JSON ── */

interface KeyValue { readonly key: string; readonly value: Readonly<Record<string, unknown>> }
interface JsonSpan {
  readonly name: string
  readonly spanId: string
  readonly parentSpanId?: string
  readonly attributes: ReadonlyArray<KeyValue>
  readonly events?: ReadonlyArray<{ readonly name: string; readonly attributes: ReadonlyArray<KeyValue> }>
}
interface JsonPoint { readonly attributes: ReadonlyArray<KeyValue>; readonly asDouble?: number; readonly asInt?: number | string }
interface JsonMetric { readonly name: string; readonly sum?: { readonly dataPoints: ReadonlyArray<JsonPoint> } }

const valueOf = (value: Readonly<Record<string, unknown>>): unknown => value.stringValue ?? value.intValue ?? value.doubleValue ?? value.boolValue
const attributesOf = (list: ReadonlyArray<KeyValue>): Record<string, unknown> =>
  Object.fromEntries(list.map((entry) => [entry.key, valueOf(entry.value)]))
const json = (post: Post): unknown => JSON.parse(new TextDecoder().decode(post.body))

const spansOf = (posts: ReadonlyArray<Post>): ReadonlyArray<JsonSpan> => posts.filter((post) => post.path === "/v1/traces").flatMap((post) =>
  (json(post) as { readonly resourceSpans: ReadonlyArray<{ readonly scopeSpans: ReadonlyArray<{ readonly spans: ReadonlyArray<JsonSpan> }> }> })
    .resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)))
const resourcesOf = (posts: ReadonlyArray<Post>, path: string): ReadonlyArray<Record<string, unknown>> => posts.filter((post) => post.path === path).map((post) =>
  attributesOf((json(post) as { readonly [key: string]: ReadonlyArray<{ readonly resource: { readonly attributes: ReadonlyArray<KeyValue> } }> })[path === "/v1/traces" ? "resourceSpans" : "resourceMetrics"]![0]!.resource.attributes))
/** The last export of a metric (exports are cumulative snapshots). */
const lastMetric = (posts: ReadonlyArray<Post>, name: string): JsonMetric | undefined => posts.filter((post) => post.path === "/v1/metrics").flatMap((post) =>
  (json(post) as { readonly resourceMetrics: ReadonlyArray<{ readonly scopeMetrics: ReadonlyArray<{ readonly metrics: ReadonlyArray<JsonMetric> }> }> })
    .resourceMetrics.flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics))).filter((metric) => metric.name === name).at(-1)
const pointValue = (point: JsonPoint): number => Number(point.asDouble ?? point.asInt)

describe("OtlpTelemetryLive", () => {
  test("flushTelemetry posts the turn's spans, with agent.turn and its ids, and the telemetry metrics while the layer is open", async () => {
    const { unflushed, posts, result } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { url, posts } = yield* collector
      return yield* Effect.gen(function* () {
        const result = yield* scriptedTurn({ telemetry: { prices: { [MODEL]: PRICE }, metricAttributes: { "deployment.environment": "test" } } })
        // An hour's interval: nothing is posted until the flush.
        const unflushed = posts.length
        yield* flushTelemetry
        // Read inside the layer, before its close posts what is left: both signals arrived through one flush.
        return { unflushed, posts: [...posts], result }
      }).pipe(
        Effect.provide(OtlpTelemetryLive({ baseUrl: `${url}/`, protocol: "http/json", headers: { authorization: "Bearer collector-key" }, exportInterval: "1 hour" })),
        // One registry for the turn and the exporter, apart from other tests'.
        Effect.provideService(Metric.MetricRegistry, new Map()),
      )
    })))
    expect(result.outcome).toBe("completed")
    expect(unflushed).toBe(0)
    expect(new Set(posts.map((post) => post.path))).toEqual(new Set(["/v1/traces", "/v1/metrics"]))
    expect(posts.every((post) => post.contentType === "application/json" && post.headers.authorization === "Bearer collector-key")).toBe(true)
    expect(resourcesOf(posts, "/v1/traces")[0]?.["service.name"]).toBe("efferent")

    const spans = spansOf(posts)
    const turn = spans.find((span) => span.name === "agent.turn")
    expect(turn).toBeDefined()
    expect(attributesOf(turn!.attributes)).toMatchObject({
      "efferent.session.id": "00000000-0000-4000-8000-000000000016",
      "efferent.run.id": "run-1",
      "efferent.outcome": "completed",
    })
    expect(Number(attributesOf(turn!.attributes)["efferent.turn"])).toBe(1)
    expect(turn!.events?.map((event) => event.name)).toContain("efferent.step.usage")
    const run = spans.find((span) => span.name === "engine.run")
    expect(run?.parentSpanId).toBe(turn!.spanId)
    expect(attributesOf(run!.attributes)["efferent.run.id"]).toBe("run-1")

    const tokens = lastMetric(posts, "efferent.llm.tokens")
    const cacheWrite = tokens?.sum?.dataPoints.find((point) => attributesOf(point.attributes)["efferent.token.kind"] === "cache_write")
    expect(attributesOf(cacheWrite!.attributes)).toEqual({ "deployment.environment": "test", "efferent.model": MODEL, "efferent.token.kind": "cache_write" })
    expect(pointValue(cacheWrite!)).toBe(30)
    const total = tokens!.sum!.dataPoints.reduce((sum, point) => sum + pointValue(point), 0)
    expect(total).toBe(result.usage.totalTokens)
    expect(lastMetric(posts, "efferent.llm.cost")?.sum?.dataPoints.length).toBe(1)
    // Agent.turn's own metrics ride the same export.
    expect(lastMetric(posts, "efferent.turns")).toBeDefined()
  })

  test("encodes protobuf by default, and exports only the signals it has a URL for", async () => {
    const posts = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { url, posts } = yield* collector
      return yield* Effect.void.pipe(Effect.withSpan("probe"), Effect.andThen(Metric.update(Metric.counter("probe.count", { incremental: true }), 1)), Effect.andThen(flushTelemetry), Effect.as(posts), Effect.map((sent) => [...sent])).pipe(
        Effect.provide(OtlpTelemetryLive({ tracesUrl: `${url}/collect/spans`, serviceName: "probe-service", exportInterval: "1 hour" })),
        Effect.provideService(Metric.MetricRegistry, new Map()),
      )
    })))
    expect(posts.length).toBeGreaterThan(0)
    expect(posts.every((post) => post.path === "/collect/spans" && post.contentType === "application/x-protobuf" && post.body.length > 0)).toBe(true)
    expect(new TextDecoder().decode(posts[0]!.body)).toContain("probe-service")
  })

  test("with nothing to export to, is a Flusher that does nothing", async () => {
    const exit = await Effect.runPromise(flushTelemetry.pipe(Effect.provide(OtlpTelemetryLive({})), Effect.exit))
    expect(Exit.isSuccess(exit)).toBe(true)
  })
})

describe("OtlpTelemetryFromEnv", () => {
  test("exports where the environment says, with its headers and service name", async () => {
    const posts = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { url, posts } = yield* collector
      const env = {
        OTEL_EXPORTER_OTLP_ENDPOINT: url,
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_HEADERS: "x-tenant=acme%20co,authorization=Bearer%20env-key",
        OTEL_SERVICE_NAME: "env-service",
        OTEL_METRICS_EXPORTER: "none",
      }
      return yield* Effect.void.pipe(Effect.withSpan("probe"), Effect.andThen(flushTelemetry), Effect.as(posts), Effect.map((sent) => [...sent])).pipe(
        Effect.provide(OtlpTelemetryFromEnv({ serviceName: "default-service" })),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
        Effect.provideService(Metric.MetricRegistry, new Map()),
      )
    })))
    expect(posts.map((post) => post.path)).toEqual(["/v1/traces"])
    expect(posts[0]?.headers["x-tenant"]).toBe("acme co")
    expect(posts[0]?.headers.authorization).toBe("Bearer env-key")
    expect(resourcesOf(posts, "/v1/traces")[0]?.["service.name"]).toBe("env-service")
    expect(spansOf(posts).map((span) => span.name)).toEqual(["probe"])
  })

  test("OtlpTelemetryHttpFromEnv posts through the host's HttpClient", async () => {
    const posts = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { url, posts } = yield* collector
      // The host's client: fetch, stamping every request (as a proxying client would route it).
      const hostClient = Layer.effect(HttpClient.HttpClient, HttpClient.HttpClient.pipe(
        Effect.map(HttpClient.mapRequest(HttpClientRequest.setHeader("x-host-client", "yes"))),
      )).pipe(Layer.provide(FetchHttpClient.layer))
      return yield* Effect.void.pipe(Effect.withSpan("probe"), Effect.andThen(flushTelemetry), Effect.as(posts), Effect.map((sent) => [...sent])).pipe(
        Effect.provide(OtlpTelemetryHttpFromEnv().pipe(Layer.provide(hostClient))),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${url}/v1/traces`, OTEL_METRICS_EXPORTER: "none" } })),
        Effect.provideService(Metric.MetricRegistry, new Map()),
      )
    })))
    expect(posts.map((post) => [post.path, post.headers["x-host-client"]])).toEqual([["/v1/traces", "yes"]])
  })

  test("fails with the variable's error when it is set to what it cannot use", async () => {
    const exit = await Effect.runPromise(flushTelemetry.pipe(
      Effect.provide(OtlpTelemetryFromEnv()),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318", OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" } })),
      Effect.exit,
    ))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain("OTEL_EXPORTER_OTLP_PROTOCOL")
  })
})
