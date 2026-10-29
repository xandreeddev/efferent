import { Clock, Duration, Effect, Layer, Match, Metric, Option, Ref } from "effect"
import type { Tracer } from "effect"
import { RunContext, TurnEvent, TurnEvents } from "@xandreed/core"
import type { TurnEventOf } from "@xandreed/core"
import { TelemetryMetrics } from "./telemetry-metrics.js"
import { telemetryDefaults } from "./telemetry.entity.js"
import type { TelemetryOptions } from "./telemetry.entity.js"
import { metricAttributesOf, modelAttribute, responseCost, tokenCounts, usageEventAttributes } from "./telemetry.entity.functions.js"

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
 * (`efferent.stream.fallback`), and keeps the turn's running cost in
 * `efferent.cost` (priced responses only). A response with no usage (a
 * host-planned step 0) records nothing. Recording never fails the turn.
 */
export const TurnTelemetryLive = (options: Partial<TelemetryOptions> = {}): Layer.Layer<never, never, RunContext | TurnEvents> =>
  Layer.effectDiscard(Effect.gen(function* () {
    const config: TelemetryOptions = { ...telemetryDefaults, ...options }
    const run = yield* RunContext
    const events = yield* TurnEvents
    const span: Option.Option<Tracer.Span> = config.spanEvents ? yield* Effect.option(Effect.currentSpan) : Option.none()
    const spent = yield* Ref.make(0)

    /** Write to the captured span, if there is one, at the clock's current time. */
    const onSpan = (write: (target: Tracer.Span, now: bigint) => void): Effect.Effect<void> => Option.match(span, {
      onNone: () => Effect.void,
      onSome: (target) => Clock.currentTimeNanos.pipe(Effect.map((now) => write(target, now))),
    })
    const count = <Input, State>(metric: Metric.Metric<Input, State>, own: Readonly<Record<string, string>>, input: Input): Effect.Effect<void> =>
      Metric.update(Metric.withAttributes(metric, metricAttributesOf(config.metricAttributes, own)), input)

    const record = (event: Recorded): Effect.Effect<void> => Match.valueTags(event, {
      "assistant.message": (message) => message.usage.totalTokens === 0 ? Effect.void : Effect.gen(function* () {
        const model = modelAttribute(message.model)
        yield* Effect.forEach(tokenCounts(message.usage), (tokens) =>
          count(TelemetryMetrics.tokens, { "efferent.model": model, "efferent.token.kind": tokens.kind }, tokens.count), { concurrency: 1, discard: true })
        const cost = responseCost(config.prices, message.model, message.usage)
        const total = yield* Option.match(cost, {
          onNone: () => Effect.succeed(Option.none<number>()),
          onSome: (amount) => count(TelemetryMetrics.cost, { "efferent.model": model }, amount).pipe(
            Effect.andThen(Ref.updateAndGet(spent, (sum) => sum + amount)),
            Effect.map(Option.some),
          ),
        })
        yield* onSpan((target, now) => {
          target.event("efferent.step.usage", now, {
            "efferent.step": message.step,
            "efferent.model": model,
            ...usageEventAttributes(message.usage),
            ...Option.match(cost, { onNone: () => ({}), onSome: (amount) => ({ "efferent.cost": amount }) }),
          })
          Option.match(total, { onNone: () => undefined, onSome: (sum) => target.attribute("efferent.cost", sum) })
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
  }))
