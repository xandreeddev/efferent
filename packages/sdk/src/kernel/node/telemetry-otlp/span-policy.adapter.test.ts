import { describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Layer, Metric, Option, Schema } from "effect"
import type { Tracer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { flushTelemetry, otlpTelemetryFromEnvOver, otlpTelemetryOver } from "./otlp-telemetry.adapter.js"
import { WITHHELD } from "./span-policy.adapter.js"
import type { OtlpSpanPolicy } from "./otlp-telemetry.entity.js"

/* ── a recording HttpClient: every OTLP/JSON trace post, decoded ── */

interface KeyValue { readonly key: string; readonly value: Readonly<Record<string, unknown>> }
interface JsonSpan {
  readonly name: string
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId?: string
  readonly attributes: ReadonlyArray<KeyValue>
  readonly events?: ReadonlyArray<{ readonly name: string; readonly attributes: ReadonlyArray<KeyValue> }>
}
interface TraceBody { readonly resourceSpans: ReadonlyArray<{ readonly scopeSpans: ReadonlyArray<{ readonly spans: ReadonlyArray<JsonSpan> }> }> }

const valueOf = (value: Readonly<Record<string, unknown>>): unknown => value.stringValue ?? value.intValue ?? value.doubleValue ?? value.boolValue
const attributesOf = (list: ReadonlyArray<KeyValue>): Record<string, unknown> => Object.fromEntries(list.map((entry) => [entry.key, valueOf(entry.value)]))

const recordingClient = (bodies: Array<string>) => HttpClient.make((request) => Effect.sync(() => {
  if (request.body._tag === "Uint8Array") bodies.push(request.body.text ?? new TextDecoder().decode(request.body.body))
  return HttpClientResponse.fromWeb(request, Response.json({}))
}))

const spansOf = (bodies: ReadonlyArray<string>): ReadonlyArray<JsonSpan> => bodies.flatMap((body) =>
  (JSON.parse(body) as TraceBody).resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)))
const named = (spans: ReadonlyArray<JsonSpan>, name: string): JsonSpan => {
  const span = spans.find((candidate) => candidate.name === name)
  expect(span).toBeDefined()
  return span!
}

/** Run `program` under `otlpTelemetryOver` with `spans`, traces only, over a recording client; the spans it posted. */
const exported = <A, E>(spans: OtlpSpanPolicy | undefined, program: Effect.Effect<A, E>) => Effect.runPromise(Effect.gen(function* () {
  const bodies: Array<string> = []
  yield* program.pipe(
    Effect.andThen(flushTelemetry),
    Effect.provide(otlpTelemetryOver({
      tracesUrl: "http://collector.test/v1/traces", protocol: "http/json", exportInterval: "1 hour",
      ...(spans === undefined ? {} : { spans }),
    }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, recordingClient(bodies))))),
    Effect.provideService(Metric.MetricRegistry, new Map()),
  )
  return spansOf(bodies)
}))

const nested = Effect.void.pipe(
  Effect.withSpan("leaf"),
  Effect.withSpan("internal.inner", { attributes: { "app.internal": true } }),
  Effect.withSpan("internal.outer", { attributes: { "app.internal": true } }),
  Effect.withSpan("middle"),
  Effect.withSpan("root"),
)
const dropInternal: OtlpSpanPolicy = { keep: (span) => span.attributes.get("app.internal") !== true }

describe("otlpTelemetryOver with a span policy", () => {
  test("a dropped span is never sent and its children are sent under its nearest kept ancestor", async () => {
    const spans = await exported(dropInternal, nested)
    expect(spans.map((span) => span.name).toSorted()).toEqual(["leaf", "middle", "root"])
    const root = named(spans, "root")
    const middle = named(spans, "middle")
    const leaf = named(spans, "leaf")
    expect(middle.parentSpanId).toBe(root.spanId)
    // Two dropped spans in a row: the leaf skips both.
    expect(leaf.parentSpanId).toBe(middle.spanId)
    expect(new Set(spans.map((span) => span.traceId)).size).toBe(1)
  })

  test("without a policy every span is sent under its own parent", async () => {
    const spans = await exported(undefined, nested)
    expect(spans.map((span) => span.name).toSorted()).toEqual(["internal.inner", "internal.outer", "leaf", "middle", "root"])
    expect(named(spans, "leaf").parentSpanId).toBe(named(spans, "internal.inner").spanId)
  })

  test("keep runs once per span, and a dropped root's children start traces of their own", async () => {
    const asked: Array<string> = []
    const spans = await exported({ keep: (span) => { asked.push(span.name); return span.name !== "root" } },
      Effect.all([Effect.void.pipe(Effect.withSpan("first")), Effect.void.pipe(Effect.withSpan("second"))], { concurrency: 1 }).pipe(Effect.withSpan("root")))
    expect(asked.toSorted()).toEqual(["first", "root", "second"])
    expect(spans.map((span) => span.name).toSorted()).toEqual(["first", "second"])
    expect(spans.every((span) => span.parentSpanId === undefined || span.parentSpanId === "")).toBe(true)
  })

  test("a dropped span still ends for the program that holds it", async () => {
    const held: Array<Tracer.Span> = []
    await exported(dropInternal, Effect.currentSpan.pipe(Effect.tap((span) => Effect.sync(() => held.push(span))), Effect.withSpan("internal.probe", { attributes: { "app.internal": true } })))
    expect(held.map((span) => [span.name, span.status._tag])).toEqual([["internal.probe", "Ended"]])
  })

  test("an attribute the policy leaves out never reaches the exporter, on spans and on span events", async () => {
    const spans = await exported({
      attribute: (_span, key, value) => key.startsWith("secret.") ? Option.none() : key === "user.email" ? Option.some("redacted") : Option.some(value),
    }, Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({ "secret.token": "abc", "user.email": "someone@example.test" })
      const span = yield* Effect.currentSpan
      span.event("lookup", 0n, { "secret.query": "the query", "result.count": 3 })
    }).pipe(Effect.withSpan("work", { attributes: { "secret.opened": "x", "work.kind": "probe" } })))
    const work = named(spans, "work")
    expect(attributesOf(work.attributes)).toEqual({ "work.kind": "probe", "user.email": "redacted" })
    expect(work.events?.map((event) => [event.name, attributesOf(event.attributes)])).toEqual([["lookup", { "result.count": 3 }]])
  })

  test("the hooks read every attribute the program set, the ones they leave out included", async () => {
    const allowed = new Set(["work.kind"])
    const held: Array<ReadonlyMap<string, unknown>> = []
    const spans = await exported({
      attribute: (span, key, value) => allowed.has(key) && span.attributes.get("app.sensitive") !== true ? Option.some(value) : Option.none(),
    }, Effect.all([
      Effect.currentSpan.pipe(Effect.tap((span) => Effect.sync(() => held.push(new Map(span.attributes)))), Effect.withSpan("open", { attributes: { "work.kind": "probe", "work.note": "x" } })),
      Effect.void.pipe(Effect.withSpan("marked", { attributes: { "work.kind": "probe" } }), Effect.annotateSpans({ "app.sensitive": true })),
    ], { concurrency: 1 }))
    expect(attributesOf(named(spans, "open").attributes)).toEqual({ "work.kind": "probe" })
    // The marker reached the span first, so the hook left the span's own attributes out.
    expect(attributesOf(named(spans, "marked").attributes)).toEqual({})
    expect([...held[0]!.entries()]).toEqual([["work.kind", "probe"], ["work.note", "x"]])
  })

  test("a hook that throws drops what it was asked about", async () => {
    // A host hook with a bug: parsing text that is not JSON throws.
    const broken = (): never => JSON.parse("not json") as never
    const spans = await exported({
      keep: (span) => span.name === "broken" ? broken() : true,
      attribute: (_span, key, value) => key === "bad" ? broken() : Option.some(value),
    }, Effect.void.pipe(Effect.withSpan("broken"), Effect.withSpan("fine", { attributes: { bad: 1, good: 2 } })))
    expect(spans.map((span) => span.name)).toEqual(["fine"])
    expect(attributesOf(named(spans, "fine").attributes)).toEqual({ good: 2 })
  })
})

describe("otlpTelemetryFromEnvOver with a span policy", () => {
  test("applies the defaults' policy to the export the environment configures", async () => {
    const bodies: Array<string> = []
    await Effect.runPromise(nested.pipe(
      Effect.andThen(flushTelemetry),
      Effect.provide(otlpTelemetryFromEnvOver({ spans: dropInternal }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, recordingClient(bodies))))),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: {
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector.test/v1/traces", OTEL_EXPORTER_OTLP_PROTOCOL: "http/json", OTEL_METRICS_EXPORTER: "none",
      } })),
      Effect.provideService(Metric.MetricRegistry, new Map()),
    ))
    const spans = spansOf(bodies)
    expect(spans.map((span) => span.name).toSorted()).toEqual(["leaf", "middle", "root"])
    expect(named(spans, "leaf").parentSpanId).toBe(named(spans, "middle").spanId)
  })
})

describe("otlpTelemetryOver with content off", () => {
  /** A span that logs and then fails with words of its own, exported with content off or on: the bodies posted. */
  const failing = (content: boolean) => Effect.runPromise(Effect.gen(function* () {
    const bodies: Array<string> = []
    yield* Effect.gen(function* () {
      yield* Effect.logWarning("the request said secret words")
      return yield* Effect.fail(new Refused({ message: "refused: the request said secret words" }))
    }).pipe(
      Effect.withSpan("failing"),
      Effect.exit,
      Effect.andThen(flushTelemetry),
      Effect.provide(otlpTelemetryOver({ tracesUrl: "http://collector.test/v1/traces", protocol: "http/json", exportInterval: "1 hour", content })
        .pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, recordingClient(bodies))))),
      Effect.provideService(Metric.MetricRegistry, new Map()),
    )
    return bodies.join("\n")
  }))

  test("a failed span is sent with its failure's type and fixed words, and a log as `log` with its level: none of their words", async () => {
    const off = await failing(false)
    expect(off).not.toContain("secret words")
    const span = named(spansOf([off]), "failing")
    expect(span.events?.map((event) => [event.name, attributesOf(event.attributes)])).toEqual([
      ["log", expect.objectContaining({ "effect.logLevel": "WARN" })],
      ["exception", { "exception.type": "Refused", "exception.message": WITHHELD, "exception.stacktrace": `Refused: ${WITHHELD}` }],
    ])
    expect((JSON.parse(off) as { readonly resourceSpans: ReadonlyArray<{ readonly scopeSpans: ReadonlyArray<{ readonly spans: ReadonlyArray<{ readonly status: { readonly message?: string } }> }> }> })
      .resourceSpans[0]!.scopeSpans[0]!.spans[0]!.status.message).toBe(WITHHELD)
    // With content on, both say what they said.
    expect((await failing(true)).match(/secret words/g)?.length).toBeGreaterThanOrEqual(2)
  })
})

class Refused extends Schema.TaggedError<Refused>()("Refused", { message: Schema.String }) {}
