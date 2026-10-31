import { Clock, Duration, Effect, Layer, Match, Metric, Option, Ref } from "effect"
import type { Tracer } from "effect"
import { CurrentModelCallRecorder, formatModelSelection, ModelCallUsage, RunContext, TurnEvent, TurnEvents } from "@xandreed/core"
import type { ModelCallData, TokenUsage, TurnEventOf } from "@xandreed/core"
import { TelemetryMetrics } from "./telemetry-metrics.js"
import { telemetryDefaults } from "./telemetry.entity.js"
import type { TelemetryOptions } from "./telemetry.entity.js"
import { metricAttributesOf, modelAttribute, priceOf, responseCost, tokenCounts, usageEventAttributes } from "./telemetry.entity.functions.js"

/** The events the plugin records; every other event passes it by. */
const RECORDED = ["assistant.message", "tool.completed", "tool.refused", "step.ended", "stream.fallback"] as const
type Recorded = TurnEventOf<typeof RECORDED[number]>
const isRecorded = TurnEvent.isAnyOf(RECORDED)

/**
 * The turn's telemetry: one inline subscription to the turn's events that
 * records the plugin's metrics (`TelemetryMetrics`) from them, and, with
 * `spanEvents`, writes to the span current where the layer is built. Under
 * `Agent.turn` that span is the turn's `agent.turn` (the turn-dependent
 * plugins are built inside it); in a host's own composition it is whatever
 * span encloses the build, `traceTurn`'s when the host uses it (it must
 * stay open while the turn runs: a tracer drops what is written to a span
 * that ended). Whatever span publishes an event, it lands there. On that span
 * it sets `efferent.session.id`, `efferent.run.id` and `efferent.turn` when
 * built, adds an event per response with usage (`efferent.step.usage`), per
 * refused call (`efferent.tool.refused`) and per stream fallback
 * (`efferent.stream.fallback`). The optional turn-owned recorder supplies
 * `efferent.model.called` events and running cost for all priced calls,
 * including helpers and discarded outcomes, with unknown/partial/unpriced
 * coverage. Prior durable calls affect the span without incrementing global
 * metrics again. A turn with no ledger uses selected-response legacy facts
 * when the recorder closes; manual composition without observation keeps the
 * existing inline path. A host-planned step 0 creates no billed model call.
 * Recording never fails the turn.
 *
 * @public
 */
export const TurnTelemetryLive = (options: Partial<TelemetryOptions> = {}): Layer.Layer<never, never, RunContext | TurnEvents> =>
  Layer.effectDiscard(Effect.gen(function* () {
    const config: TelemetryOptions = { ...telemetryDefaults, ...options }
    const run = yield* RunContext
    const events = yield* TurnEvents
    const recorder = yield* CurrentModelCallRecorder
    const span: Option.Option<Tracer.Span> = config.spanEvents ? yield* Effect.option(Effect.currentSpan) : Option.none()
    const spent = yield* Ref.make(0)
    const ledger = yield* Ref.make(false)
    const coverage = yield* Ref.make({ calls: 0, unknown: 0, partial: 0, unpriced: 0 })

    /** Write to the captured span, if there is one, at the clock's current time. */
    const onSpan = (write: (target: Tracer.Span, now: bigint) => void): Effect.Effect<void> => Option.match(span, {
      onNone: () => Effect.void,
      onSome: (target) => Clock.currentTimeNanos.pipe(Effect.map((now) => write(target, now))),
    })
    const count = <Input, State>(metric: Metric.Metric<Input, State>, own: Readonly<Record<string, string>>, input: Input): Effect.Effect<void> =>
      Metric.update(Metric.withAttributes(metric, metricAttributesOf(config.metricAttributes, own)), input)

    const account = (model: Option.Option<string>, usage: TokenUsage, replayed: boolean) => Effect.gen(function* () {
      const name = modelAttribute(model)
      const cost = responseCost(config.prices, model, usage)
      if (!replayed) {
        yield* Effect.forEach(tokenCounts(usage), (tokens) => count(TelemetryMetrics.tokens, { "efferent.model": name, "efferent.token.kind": tokens.kind }, tokens.count), { concurrency: 1, discard: true })
        yield* Option.match(cost, { onNone: () => Effect.void, onSome: (amount) => count(TelemetryMetrics.cost, { "efferent.model": name }, amount) })
      }
      yield* Option.match(cost, {
        onNone: () => Effect.void,
        onSome: (amount) => Ref.updateAndGet(spent, (sum) => sum + amount).pipe(Effect.flatMap((total) => onSpan((target) => target.attribute("efferent.cost", total)))),
      })
    })
    const called = (data: ModelCallData, info: { readonly replayed: boolean }) => Effect.gen(function* () {
      yield* Ref.set(ledger, true)
      const model = Option.map(data.model, formatModelSelection)
      const usage = ModelCallUsage.match(data.usage, { Unknown: () => Option.none<TokenUsage>(), Known: ({ usage }) => Option.some(usage), Partial: ({ usage }) => Option.some(usage) })
      const cost = Option.flatMap(usage, (value) => responseCost(config.prices, model, value))
      const priced = Option.isSome(priceOf(config.prices, model))
      const attributes = {
        "efferent.model": modelAttribute(model), "efferent.call.purpose": data.purpose,
        "efferent.call.outcome": data.outcome._tag, "efferent.usage.coverage": data.usage._tag,
        "efferent.cost.priced": String(priced),
      }
      if (!info.replayed) yield* count(TelemetryMetrics.modelCalls, attributes, 1)
      yield* Option.match(usage, { onNone: () => Effect.void, onSome: (value) => account(model, value, info.replayed) })
      const total = yield* Ref.updateAndGet(coverage, (before) => ({
        calls: before.calls + 1, unknown: before.unknown + (ModelCallUsage.guards.Unknown(data.usage) ? 1 : 0),
        partial: before.partial + (ModelCallUsage.guards.Partial(data.usage) ? 1 : 0), unpriced: before.unpriced + (priced ? 0 : 1),
      }))
      yield* onSpan((target, now) => {
        target.event("efferent.model.called", now, {
          ...attributes, "efferent.model.call_id": data.callId, "efferent.model.attempt": data.attempt,
          "efferent.model.method": data.method, "efferent.model.duration_ms": data.durationMs,
          "efferent.model.replayed": info.replayed,
          ...Option.match(data.run, { onNone: () => ({}), onSome: (run) => ({ "efferent.run.ordinal": run }) }),
          ...Option.match(data.step, { onNone: () => ({}), onSome: (step) => ({ "efferent.step": step }) }),
          ...Option.match(usage, { onNone: () => ({}), onSome: usageEventAttributes }),
          ...Option.match(cost, { onNone: () => ({}), onSome: (amount) => ({ "efferent.cost": amount }) }),
        })
        target.attribute("efferent.model.calls", total.calls)
        target.attribute("efferent.model.calls.unknown", total.unknown)
        target.attribute("efferent.model.calls.partial", total.partial)
        target.attribute("efferent.model.calls.unpriced", total.unpriced)
      })
    })

    const record = (event: Recorded): Effect.Effect<void> => Match.valueTags(event, {
      "assistant.message": (message) => message.usage.totalTokens === 0 ? Effect.void : Effect.gen(function* () {
        const model = modelAttribute(message.model)
        const cost = responseCost(config.prices, message.model, message.usage)
        if (recorder.observe === undefined) yield* account(message.model, message.usage, false)
        yield* onSpan((target, now) => {
          target.event("efferent.step.usage", now, {
            "efferent.step": message.step,
            "efferent.model": model,
            ...usageEventAttributes(message.usage),
            ...Option.match(cost, { onNone: () => ({}), onSome: (amount) => ({ "efferent.cost": amount }) }),
          })
        })
      }),
      "tool.completed": (completed) => {
        const own = { "efferent.tool": completed.tool, "efferent.ok": String(completed.ok) }
        return count(TelemetryMetrics.toolCalls, own, 1).pipe(
          Effect.andThen(count(TelemetryMetrics.toolDuration, own, Duration.millis(completed.durationMs))),
        )
      },
      "tool.refused": (refused) => count(TelemetryMetrics.toolRefused, { "efferent.tool": refused.tool, "efferent.refusal.reason": refused.reason }, 1).pipe(
        Effect.andThen(onSpan((target, now) => target.event("efferent.tool.refused", now, {
          "efferent.step": refused.step,
          "efferent.tool": refused.tool,
          "efferent.tool.invocation_id": refused.invocationId,
          "efferent.refusal.reason": refused.reason,
        }))),
      ),
      "step.ended": (ended) => count(TelemetryMetrics.steps, { "efferent.step.status": ended.status }, 1),
      "stream.fallback": (fallback) => count(TelemetryMetrics.streamFallbacks, {}, 1).pipe(
        Effect.andThen(onSpan((target, now) => target.event("efferent.stream.fallback", now, {
          "efferent.step": fallback.step,
          "efferent.stream.fallback.message": fallback.message,
        }))),
      ),
    })

    yield* onSpan((target) => {
      target.attribute("efferent.session.id", run.session.id)
      target.attribute("efferent.run.id", run.runId)
      target.attribute("efferent.turn", run.admitted.turn)
    })
    yield* events.subscribe((event) => isRecorded(event) ? Option.some(event) : Option.none(), record)
    yield* recorder.observe?.({
      called,
      closed: (legacy) => Ref.get(ledger).pipe(Effect.flatMap((hasCalls) => hasCalls ? Effect.void : Effect.forEach(legacy, (fact) => account(fact.model, fact.usage, fact.replayed), { concurrency: 1, discard: true }))),
    }) ?? Effect.void
  }))
