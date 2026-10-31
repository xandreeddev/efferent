import { Effect, Option, Ref, Schema } from "effect"
import type { Scope } from "effect"
import type { ConformanceCheck } from "../conformance.entity.js"
import { check, expect } from "../conformance.functions.js"
import { ModelCallData, ModelCallId } from "../domain/model-call.entity.js"
import type { ModelCallLegacyUsage } from "../domain/model-call.entity.js"
import { ModelId, ModelSelection, ProviderId } from "../domain/model-selection.entity.js"
import { zeroUsage } from "../domain/token-usage.entity.functions.js"
import type { ModelCallRecorder } from "../ports/model-call-recorder.port.js"
import { SessionLogError } from "../session/session-log.entity.js"
import type { TurnError } from "../session/sessions.entity.js"

/** A fresh turn-owned recorder, its durable facts and controlled write failure. @public */
export interface ModelCallRecorderFixture {
  /** This kit proves a full turn-owned durable AND observing adapter. */
  readonly recorder: ModelCallRecorder & { readonly observe: NonNullable<ModelCallRecorder["observe"]> }
  readonly stored: Effect.Effect<ReadonlyArray<ModelCallData>, TurnError>
  readonly failNext: (error: TurnError) => Effect.Effect<void>
  readonly close: Effect.Effect<void, TurnError>
}

/** Seed facts already durable before this recorder's owner starts. @public */
export interface ModelCallRecorderSubject {
  readonly open: (seed: {
    readonly calls: ReadonlyArray<ModelCallData>
    readonly legacy: ReadonlyArray<ModelCallLegacyUsage>
  }) => Effect.Effect<ModelCallRecorderFixture, unknown, Scope.Scope>
}

const empty = { calls: [], legacy: [] }
const data = (id: string, usage: ModelCallData["usage"] = { _tag: "Unknown" }): ModelCallData => ({
  callId: ModelCallId.make(id), attempt: 1, purpose: "Helper", method: "Text",
  model: Option.some(new ModelSelection({ provider: ProviderId.make("actual"), modelId: ModelId.make("backup") })),
  runId: Option.none(), run: Option.none(), step: Option.none(), durationMs: 4,
  usage, outcome: { _tag: "Completed" },
})
const wire = (values: ReadonlyArray<ModelCallData>) => Schema.encodeEffect(Schema.Array(ModelCallData))(values).pipe(Effect.map(JSON.stringify))

/** Durable record/ACK, sticky keys and full owner-lifetime observer contracts. @public */
export const modelCallRecorderConformance = (subject: ModelCallRecorderSubject): ReadonlyArray<ConformanceCheck> => [
  check("terminal facts are durable exactly as reported before observers run", "record-durable", () => Effect.scoped(Effect.gen(function* () {
    const fixture = yield* subject.open(empty)
    const delivered = yield* Ref.make<ReadonlyArray<ModelCallData>>([])
    const durableAtDelivery = yield* Ref.make(true)
    yield* fixture.recorder.observe({
      called: (call) => fixture.stored.pipe(
        Effect.tap((stored) => Ref.update(durableAtDelivery, (holds) => holds && stored.some((value) => value.callId === call.callId && value.attempt === call.attempt))),
        Effect.andThen(Ref.update(delivered, (all) => [...all, call])),
        Effect.orDie,
      ),
      closed: () => Effect.void,
    })
    const calls = [data("known", { _tag: "Known", usage: zeroUsage }), data("unknown"),
      data("partial", { _tag: "Partial", usage: { ...zeroUsage, inputTokens: 8, totalTokens: 8 }, reported: ["inputTokens"] })]
    yield* Effect.forEach(calls, fixture.recorder.record, { concurrency: 1, discard: true })
    yield* expect("record-durable", (yield* wire(yield* fixture.stored)) === (yield* wire(calls)), "the durable terminal facts lost identity, usage precision or actual model")
    yield* expect("record-durable", (yield* Ref.get(durableAtDelivery)) && (yield* wire(yield* Ref.get(delivered))) === (yield* wire(calls)), "an observer ran before durability or missed a durable record")
  }))),
  check("one terminal key keeps its first ACK and never appends twice", "terminal-once", () => Effect.scoped(Effect.gen(function* () {
    const fixture = yield* subject.open(empty)
    const first = data("same-key")
    yield* Effect.all([fixture.recorder.record(first), fixture.recorder.record(first)], { concurrency: 2 })
    yield* fixture.recorder.record({ ...first, attempt: 2 })
    yield* expect("terminal-once", (yield* wire(yield* fixture.stored)) === (yield* wire([first, { ...first, attempt: 2 }])), "the same terminal key appended twice or a distinct attempt was dropped")
  }))),
  check("a failed durable ACK stays the original TurnError without a retry append", "record-failure", () => Effect.scoped(Effect.gen(function* () {
    const fixture = yield* subject.open(empty)
    const failure = new SessionLogError({ code: "store.io", message: "recorder fixture write refused" })
    const call = data("failed-key")
    const delivered = yield* Ref.make(0)
    yield* fixture.recorder.observe({ called: () => Ref.update(delivered, (n) => n + 1), closed: () => Effect.void })
    yield* fixture.failNext(failure)
    const first = yield* Effect.result(fixture.recorder.record(call))
    const before = yield* fixture.stored
    const second = yield* Effect.result(fixture.recorder.record(call))
    yield* expect("record-failure", first._tag === "Failure" && first.failure === failure && second._tag === "Failure" && second.failure === failure
      && (yield* wire(yield* fixture.stored)) === (yield* wire(before)) && (yield* Ref.get(delivered)) === 0,
    "a recorder swallowed/replaced its write failure, retried an uncertain ACK or notified observers")
  }))),
  check("registration replays existing and fresh bootstrap facts once with their provenance", "observer-bootstrap", () => Effect.scoped(Effect.gen(function* () {
    const old = data("old-call")
    const fresh = data("fresh-bootstrap")
    const fixture = yield* subject.open({ calls: [old], legacy: [] })
    yield* fixture.recorder.record(fresh)
    const seen = yield* Ref.make<ReadonlyArray<readonly [string, boolean]>>([])
    yield* fixture.recorder.observe({ called: (call, info) => Ref.update(seen, (all) => [...all, [call.callId, info.replayed] as const]), closed: () => Effect.void })
    yield* fixture.recorder.record(fresh)
    yield* fixture.recorder.record(data("live-call"))
    yield* expect("observer-bootstrap", JSON.stringify(yield* Ref.get(seen)) === JSON.stringify([[old.callId, true], [fresh.callId, false], ["live-call", false]]), "bootstrap/live observation lost provenance or delivered a key more than once")
  }))),
  check("an observer survives its registration scope and closes with exact legacy facts", "observer-lifetime", () => Effect.scoped(Effect.gen(function* () {
    const legacy: ReadonlyArray<ModelCallLegacyUsage> = [{ model: Option.some("old:model"), usage: zeroUsage, replayed: true }]
    const fixture = yield* subject.open({ calls: [], legacy })
    const calls = yield* Ref.make(0)
    const closed = yield* Ref.make<ReadonlyArray<ReadonlyArray<ModelCallLegacyUsage>>>([])
    yield* Effect.scoped(fixture.recorder.observe({ called: () => Ref.update(calls, (n) => n + 1), closed: (facts) => Ref.update(closed, (all) => [...all, facts]) }))
    yield* fixture.recorder.record(data("after-plugin-close"))
    yield* fixture.close
    yield* fixture.close
    yield* expect("observer-lifetime", (yield* Ref.get(calls)) === 1 && JSON.stringify(yield* Ref.get(closed)) === JSON.stringify([legacy]), "observation ended with the plugin scope, lost legacy facts or closed more than once")
  }))),
  check("observer defects cannot change durable records or owner closure", "observer-soft", () => Effect.scoped(Effect.gen(function* () {
    const old = data("soft-bootstrap")
    const fresh = data("soft-live")
    const fixture = yield* subject.open({ calls: [old], legacy: [] })
    yield* fixture.recorder.observe({ called: () => Effect.die("observer fixture defect"), closed: () => Effect.die("closed observer fixture defect") })
    yield* fixture.recorder.record(fresh)
    yield* fixture.close
    yield* expect("observer-soft", (yield* wire(yield* fixture.stored)) === (yield* wire([old, fresh])), "an observer defect lost durable facts or prevented closure")
  }))),
]
