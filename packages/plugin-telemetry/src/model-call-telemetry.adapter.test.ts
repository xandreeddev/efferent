import { expect, test } from "bun:test"
import { Context, Effect, Layer, Metric, Option, Ref, Tracer } from "effect"
import {
  CurrentModelCallRecorder, makeTurnEvents, ModelCallId, ModelId, ModelSelection,
  ProviderId, RunContext, tokenUsage, TurnEvents,
} from "@xandreed/core"
import type { ModelCallData, ModelCallLegacyUsage, ModelCallObserver, ModelCallRecorder } from "@xandreed/core"
import { capturingTracer, valueIn } from "./scripted-turn.testing.js"
import { TelemetryMetrics } from "./telemetry-metrics.js"
import { TurnTelemetryLive } from "./turn-telemetry.adapter.js"

const selection = new ModelSelection({ provider: ProviderId.make("fixture"), modelId: ModelId.make("actual") })
const model = "fixture:actual"
const price = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }
const usage = tokenUsage({ inputTokens: 40, outputTokens: 10 })
const call = (name: string, observed: ModelCallData["usage"] = { _tag: "Known", usage }): ModelCallData => ({
  callId: ModelCallId.make(name), attempt: 1, purpose: "Helper", method: "Text", model: Option.some(selection),
  runId: Option.none(), run: Option.none(), step: Option.none(), durationMs: 1,
  usage: observed, outcome: { _tag: "Completed" },
})
const legacy = (replayed: boolean): ModelCallLegacyUsage => ({ model: Option.some(model), usage, replayed })
const billing = async (
  bootstrap: ReadonlyArray<{ readonly data: ModelCallData; readonly replayed: boolean }>,
  live: ReadonlyArray<ModelCallData>,
  selected: ReadonlyArray<ModelCallLegacyUsage>,
) => {
  const registry: Metric.MetricRegistry = new Map()
  const spans: Array<Tracer.NativeSpan> = []
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const events = yield* makeTurnEvents({ maxDepth: 8 })
    const current = yield* Ref.make(Option.none<ModelCallObserver>())
    const recorder: ModelCallRecorder = {
      record: () => Effect.void,
      observe: (listener) => Ref.set(current, Option.some(listener)).pipe(Effect.andThen(Effect.forEach(bootstrap,
        (fact) => listener.called(fact.data, { replayed: fact.replayed }), { concurrency: 1, discard: true }))),
    }
    const run = { session: { id: "session", owner: "fixture" }, runId: "run", admitted: { turn: 1 } } as never
    const services = Context.make(RunContext, run).pipe(Context.add(TurnEvents, events), Context.add(CurrentModelCallRecorder, recorder))
    // Close the registering plugin's own scope before the last helper arrives.
    yield* Effect.scoped(Layer.build(TurnTelemetryLive({ prices: { [model]: price } })).pipe(Effect.provide(services)))
    const listener = yield* Ref.get(current).pipe(Effect.flatMap(Option.match({ onNone: () => Effect.die("billing observer was absent"), onSome: Effect.succeed })))
    yield* Effect.forEach(live, (data) => listener.called(data, { replayed: false }), { concurrency: 1, discard: true })
    yield* listener.closed(selected)
  })).pipe(Effect.withSpan("agent.turn"), Effect.withTracer(capturingTracer(spans)), Effect.provideService(Metric.MetricRegistry, registry)))
  return { registry, span: spans.find((span) => span.name === "agent.turn")! }
}
const cost = (registry: Metric.MetricRegistry) => Effect.runPromise(valueIn(registry, TelemetryMetrics.cost, { "efferent.model": model })).then((value) => value.count)

test("billing includes prior/bootstrap/late calls on the span and only fresh calls in global metrics", async () => {
  const partial = call("late-partial", { _tag: "Partial", usage: tokenUsage({ inputTokens: 12, outputTokens: 0 }), reported: ["inputTokens"] })
  const { registry, span } = await billing([{ data: call("prior"), replayed: true }, { data: call("bootstrap"), replayed: false }], [partial], [legacy(true), legacy(false)])
  expect(await cost(registry)).toBeCloseTo(62 / 1_000_000, 12)
  expect(span.attributes.get("efferent.cost")).toBeCloseTo(112 / 1_000_000, 12)
  expect(span.attributes.get("efferent.model.calls")).toBe(3)
  expect(span.attributes.get("efferent.model.calls.partial")).toBe(1)
  expect(span.events.filter(([name]) => name === "efferent.model.called").map(([, , fields]) => fields["efferent.model.replayed"])).toEqual([true, false, false])
  expect((await Effect.runPromise(valueIn(registry, TelemetryMetrics.tokens, { "efferent.model": model, "efferent.token.kind": "input" }))).count).toBe(52)
})

test("an Unknown-only ledger suppresses legacy prices and exposes missing coverage", async () => {
  const { registry, span } = await billing([], [call("unknown", { _tag: "Unknown" })], [legacy(false)])
  expect(await cost(registry)).toBe(0)
  expect(span.attributes.has("efferent.cost")).toBe(false)
  expect(span.attributes.get("efferent.model.calls.unknown")).toBe(1)
  expect(span.attributes.get("efferent.model.calls.unpriced")).toBe(0)
  expect((await Effect.runPromise(valueIn(registry, TelemetryMetrics.modelCalls, {
    "efferent.model": model, "efferent.call.purpose": "Helper", "efferent.call.outcome": "Completed",
    "efferent.usage.coverage": "Unknown", "efferent.cost.priced": "true",
  }))).count).toBe(1)
})

test("a known response without an actual priced model keeps tokens and exposes unpriced coverage", async () => {
  const { registry, span } = await billing([], [{ ...call("unpriced"), model: Option.none() }], [])
  expect(await cost(registry)).toBe(0)
  expect(span.attributes.has("efferent.cost")).toBe(false)
  expect(span.attributes.get("efferent.model.calls.unpriced")).toBe(1)
  expect((await Effect.runPromise(valueIn(registry, TelemetryMetrics.tokens, { "efferent.model": "unknown", "efferent.token.kind": "input" }))).count).toBe(40)
})

test("legacy fallback includes prior selected usage on the span without counting it again", async () => {
  const { registry, span } = await billing([], [], [legacy(true), legacy(false)])
  expect(await cost(registry)).toBeCloseTo(50 / 1_000_000, 12)
  expect(span.attributes.get("efferent.cost")).toBeCloseTo(100 / 1_000_000, 12)
  expect(span.events).toEqual([])
})
