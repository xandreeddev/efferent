import { describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Layer, Metric, Option } from "effect"
import type { Tracer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { CurrentTraceContent } from "@xandreed/core"
import { flushTelemetry, OtlpTelemetryHttpFromEnv, OtlpTelemetryHttpLive } from "./otlp-telemetry.adapter.js"
import type { OtlpSpanPolicy } from "./otlp-telemetry.entity.js"
import { scriptedTurn } from "./scripted-turn.testing.js"

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

/** Run `program` under `OtlpTelemetryHttpLive` with `spans`, traces only, over a recording client; the spans it posted. */
const exported = <A, E>(spans: OtlpSpanPolicy | undefined, program: Effect.Effect<A, E>) => Effect.runPromise(Effect.gen(function* () {
  const bodies: Array<string> = []
  yield* program.pipe(
    Effect.andThen(flushTelemetry),
    Effect.provide(OtlpTelemetryHttpLive({
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

describe("OtlpTelemetryHttpLive with a span policy", () => {
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

  test("a turn's prompt and response stay out of its spans with trace content off, the policy installed", async () => {
    const spans = await exported({ keep: () => true }, scriptedTurn({}))
    const steps = spans.filter((span) => span.name === "engine.turn")
    expect(steps.length).toBeGreaterThan(0)
    expect(steps.some((span) => attributesOf(span.attributes)["engine.step.input"] !== undefined || attributesOf(span.attributes)["engine.step.output"] !== undefined)).toBe(false)
  })

  test("with trace content on, a metadata-only policy leaves the turn's content out and keeps its ids", async () => {
    const content = new Set(["engine.step.input", "engine.step.output"])
    const capturing = await exported(undefined, scriptedTurn({}).pipe(Effect.provideService(CurrentTraceContent, true)))
    expect(capturing.some((span) => attributesOf(span.attributes)["engine.step.input"] !== undefined)).toBe(true)

    const spans = await exported({ attribute: (_span, key, value) => content.has(key) ? Option.none() : Option.some(value) },
      scriptedTurn({}).pipe(Effect.provideService(CurrentTraceContent, true)))
    expect(spans.some((span) => Object.keys(attributesOf(span.attributes)).some((key) => content.has(key)))).toBe(false)
    const turn = named(spans, "agent.turn")
    expect(attributesOf(turn.attributes)["efferent.run.id"]).toBe("run-1")
    expect(named(spans, "engine.run").parentSpanId).toBe(turn.spanId)
  })
})

describe("OtlpTelemetryHttpFromEnv with a span policy", () => {
  test("applies the defaults' policy to the export the environment configures", async () => {
    const bodies: Array<string> = []
    await Effect.runPromise(nested.pipe(
      Effect.andThen(flushTelemetry),
      Effect.provide(OtlpTelemetryHttpFromEnv({ spans: dropInternal }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, recordingClient(bodies))))),
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
