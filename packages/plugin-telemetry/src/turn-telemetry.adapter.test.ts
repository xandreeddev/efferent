import { describe, expect, test } from "bun:test"
import { Duration, Effect, Exit, Layer, Metric, Option, Tracer } from "effect"
import { costOf, InvocationId, makeTurnEvents, RunContext, RunOrdinal, sumUsage, tokenUsage, TurnEvents, usageBreakdown } from "@xandreed/core"
import type { TurnEvent } from "@xandreed/core"
import { capturingTracer, MODEL, PRICE, RESPONSES, scriptedTurn, valueIn } from "./scripted-turn.testing.js"
import { TelemetryMetrics } from "./telemetry-metrics.js"
import type { TokenKind } from "./telemetry.entity.js"
import { TurnTelemetryLive } from "./turn-telemetry.adapter.js"

const KINDS: ReadonlyArray<TokenKind> = ["input", "cache_read", "cache_write", "reasoning", "output"]
const counted = (registry: Metric.MetricRegistry, metric: Metric.Metric<number, Metric.CounterState<number>>, attributes: Readonly<Record<string, string>>) =>
  Effect.runPromise(valueIn(registry, metric, attributes)).then((state) => state.count)

const turnSpan = (spans: ReadonlyArray<Tracer.NativeSpan>): Tracer.NativeSpan => {
  const found = spans.filter((span) => span.name === "agent.turn")
  expect(found).toHaveLength(1)
  return found[0]!
}

describe("telemetryPlugin over a scripted turn", () => {
  test("records each response's tokens by billed kind, summing to the turn's total, and its cost at the host's prices", async () => {
    const registry: Metric.MetricRegistry = new Map()
    const result = await Effect.runPromise(scriptedTurn({ registry, telemetry: { prices: { [MODEL]: PRICE } } }))
    expect(result.outcome).toBe("completed")
    const response = tokenUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 10, reasoningTokens: 5 })
    expect(result.usage).toEqual(sumUsage(Array.from({ length: RESPONSES }, () => response)))

    const kinds = await Promise.all(KINDS.map((kind) => counted(registry, TelemetryMetrics.tokens, { "efferent.model": MODEL, "efferent.token.kind": kind })))
    const expected = usageBreakdown(result.usage)
    expect(kinds).toEqual([expected.input, expected.cacheRead, expected.cacheWrite, expected.reasoning, expected.output])
    expect(kinds).toEqual([180, 90, 30, 15, 45])
    expect(kinds.reduce((sum, count) => sum + count, 0)).toBe(result.usage.totalTokens)

    const cost = await counted(registry, TelemetryMetrics.cost, { "efferent.model": MODEL })
    expect(cost).toBeCloseTo(costOf(result.usage, PRICE), 12)
  })

  test("counts the tool calls that ran, their durations, the refused call and the steps", async () => {
    const registry: Metric.MetricRegistry = new Map()
    await Effect.runPromise(scriptedTurn({ registry }))
    expect(await Promise.all([
      counted(registry, TelemetryMetrics.toolCalls, { "efferent.tool": "lookup", "efferent.ok": "true" }),
      counted(registry, TelemetryMetrics.toolCalls, { "efferent.tool": "archive", "efferent.ok": "true" }),
      counted(registry, TelemetryMetrics.toolRefused, { "efferent.tool": "archive", "efferent.refusal.reason": "tool-call-limit" }),
      counted(registry, TelemetryMetrics.steps, { "efferent.step.status": "completed" }),
      counted(registry, TelemetryMetrics.streamFallbacks, {}),
    ])).toEqual([1, 1, 1, RESPONSES, 0])
    const durations = await Effect.runPromise(valueIn(registry, TelemetryMetrics.toolDuration, { "efferent.tool": "lookup", "efferent.ok": "true" }))
    expect(durations.count).toBe(1)
    // An unpriced model has no cost.
    expect(await counted(registry, TelemetryMetrics.cost, { "efferent.model": MODEL })).toBe(0)
  })

  test("adds the host's metric attributes to every series, under the metric's own", async () => {
    const registry: Metric.MetricRegistry = new Map()
    await Effect.runPromise(scriptedTurn({ registry, telemetry: { metricAttributes: { "deployment.environment": "test", "efferent.tool": "renamed" } } }))
    expect(await Promise.all([
      counted(registry, TelemetryMetrics.tokens, { "deployment.environment": "test", "efferent.model": MODEL, "efferent.token.kind": "cache_write", "efferent.tool": "renamed" }),
      counted(registry, TelemetryMetrics.toolCalls, { "deployment.environment": "test", "efferent.tool": "lookup", "efferent.ok": "true" }),
      counted(registry, TelemetryMetrics.toolCalls, { "efferent.tool": "lookup", "efferent.ok": "true" }),
    ])).toEqual([30, 1, 0])
  })

  test("writes the turn's ids, an event per response and refusal, and the running cost on agent.turn", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const result = await Effect.runPromise(scriptedTurn({ registry: new Map(), telemetry: { prices: { [MODEL]: PRICE } }, tracer: capturingTracer(spans) }))
    const turn = turnSpan(spans)
    expect([turn.attributes.get("efferent.session.id"), turn.attributes.get("efferent.run.id"), turn.attributes.get("efferent.turn")])
      .toEqual(["00000000-0000-4000-8000-000000000016", "run-1", 1])
    expect(turn.attributes.get("efferent.cost")).toBeCloseTo(costOf(result.usage, PRICE), 12)
    expect(turn.events.map(([name]) => name)).toEqual(["efferent.step.usage", "efferent.tool.refused", "efferent.step.usage", "efferent.step.usage"])
    const usages = turn.events.filter(([name]) => name === "efferent.step.usage").map(([, , attributes]) => attributes)
    expect(usages.map((attributes) => [attributes["efferent.step"], attributes["efferent.model"], attributes["efferent.usage.cache_write_tokens"], attributes["efferent.usage.total_tokens"]]))
      .toEqual([[0, MODEL, 10, 120], [1, MODEL, 10, 120], [2, MODEL, 10, 120]])
    expect(usages[0]?.["efferent.cost"]).toBeCloseTo(costOf(tokenUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 10, reasoningTokens: 5 }), PRICE), 12)
    const refused = turn.events.find(([name]) => name === "efferent.tool.refused")?.[2]
    expect(refused).toMatchObject({ "efferent.step": 1, "efferent.tool": "archive", "efferent.refusal.reason": "tool-call-limit" })
    expect(String(refused?.["efferent.tool.invocation_id"])).toStartWith("run-1:call:")
    // Only agent.turn is written to.
    expect(spans.filter((span) => span !== turn && span.events.length > 0).map((span) => span.name)).toEqual([])
  })

  test("with spanEvents off, leaves the spans alone and still records the metrics", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const registry: Metric.MetricRegistry = new Map()
    await Effect.runPromise(scriptedTurn({ registry, telemetry: { prices: { [MODEL]: PRICE }, spanEvents: false }, tracer: capturingTracer(spans) }))
    const turn = turnSpan(spans)
    expect(turn.events).toEqual([])
    expect(turn.attributes.has("efferent.cost")).toBe(false)
    expect(await counted(registry, TelemetryMetrics.tokens, { "efferent.model": MODEL, "efferent.token.kind": "input" })).toBe(180)
  })

  test("counts a stream that fell back and puts it on the turn's span", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const registry: Metric.MetricRegistry = new Map()
    const result = await Effect.runPromise(scriptedTurn({ registry, streaming: true, tracer: capturingTracer(spans) }))
    expect(result.outcome).toBe("completed")
    expect(await counted(registry, TelemetryMetrics.streamFallbacks, {})).toBe(1)
    const fallback = turnSpan(spans).events.find(([name]) => name === "efferent.stream.fallback")?.[2]
    expect(fallback?.["efferent.step"]).toBe(0)
    expect(String(fallback?.["efferent.stream.fallback.message"])).toContain("the stream is down")
  })
})

describe("TurnTelemetryLive in a host's own composition", () => {
  /** A RunContext with only what the layer reads: the session, run and turn. */
  const runContext = Layer.succeed(RunContext, { session: { id: "session-7", owner: "host" }, runId: "run-7", admitted: { turn: 4 } } as never)
  const usage = tokenUsage({ inputTokens: 40, outputTokens: 10, cacheReadTokens: 20, reasoningTokens: 2 })
  const run = RunOrdinal.make(0)
  const published: ReadonlyArray<TurnEvent> = [
    { _tag: "step.started", step: 1, run, planned: false, activeTools: [] },
    { _tag: "assistant.message", step: 0, run, text: "", reasoning: "", model: Option.none(), toolCalls: [], usage: tokenUsage({ inputTokens: 0, outputTokens: 0 }), finishReason: "tool-calls" },
    { _tag: "assistant.message", step: 1, run, text: "hi", reasoning: "", model: Option.none(), toolCalls: [], usage, finishReason: "stop" },
    { _tag: "tool.completed", step: 1, invocationId: InvocationId.make("run-7:call:1"), tool: "probe", input: {}, ok: false, result: "no", encoded: "no", durationMs: 12, labels: {}, stage: Option.none() },
    { _tag: "stream.fallback", step: 1, run, message: "cut off" },
    { _tag: "step.ended", step: 1, run, status: "failed", results: [] },
    // A response the model could not form: the step ends malformed, without a response of its own.
    { _tag: "step.ended", step: 2, run, status: "malformed", results: [] },
  ]

  test("writes to the span current where it is built, not the publisher's", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const registry: Metric.MetricRegistry = new Map()
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const events = yield* makeTurnEvents({ maxDepth: 8 })
      const services = Layer.merge(runContext, Layer.succeed(TurnEvents, events))
      // Built under the host's turn span; published from a step span under it.
      yield* Effect.gen(function* () {
        yield* Layer.build(TurnTelemetryLive().pipe(Layer.provide(services)))
        yield* Effect.forEach(published, events.publish, { discard: true }).pipe(Effect.withSpan("host.step"))
      }).pipe(Effect.withSpan("host.turn"))
    })).pipe(Effect.withTracer(capturingTracer(spans)), Effect.provideService(Metric.MetricRegistry, registry)))
    const hostTurn = spans.find((span) => span.name === "host.turn")!
    expect(spans.find((span) => span.name === "host.step")?.events).toEqual([])
    expect([hostTurn.attributes.get("efferent.session.id"), hostTurn.attributes.get("efferent.run.id"), hostTurn.attributes.get("efferent.turn")]).toEqual(["session-7", "run-7", 4])
    // The zero-usage response (a planned step) records nothing; an unnamed model is "unknown" and unpriced.
    expect(hostTurn.events.map(([name]) => name)).toEqual(["efferent.step.usage", "efferent.stream.fallback"])
    expect(hostTurn.attributes.has("efferent.cost")).toBe(false)
    expect(await Promise.all([
      ...KINDS.map((kind) => counted(registry, TelemetryMetrics.tokens, { "efferent.model": "unknown", "efferent.token.kind": kind })),
      counted(registry, TelemetryMetrics.toolCalls, { "efferent.tool": "probe", "efferent.ok": "false" }),
      counted(registry, TelemetryMetrics.streamFallbacks, {}),
      counted(registry, TelemetryMetrics.steps, { "efferent.step.status": "failed" }),
      counted(registry, TelemetryMetrics.steps, { "efferent.step.status": "malformed" }),
    ])).toEqual([20, 20, 0, 2, 8, 1, 1, 1, 1])
    const duration = await Effect.runPromise(valueIn(registry, TelemetryMetrics.toolDuration, { "efferent.tool": "probe", "efferent.ok": "false" }))
    expect([duration.count, duration.sum]).toEqual([1, Duration.toMillis(Duration.millis(12))])
  })

  test("without a span where it is built, records the metrics only", async () => {
    const registry: Metric.MetricRegistry = new Map()
    const exit = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const events = yield* makeTurnEvents({ maxDepth: 8 })
      yield* Layer.build(TurnTelemetryLive({ prices: { probe: PRICE } }).pipe(Layer.provide(Layer.merge(runContext, Layer.succeed(TurnEvents, events)))))
      yield* events.publish(published[2]!)
    })).pipe(Effect.provideService(Metric.MetricRegistry, registry), Effect.exit))
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(await counted(registry, TelemetryMetrics.tokens, { "efferent.model": "unknown", "efferent.token.kind": "output" })).toBe(8)
  })
})
