import { Context, Deferred, Effect, Exit, Option, Ref, Schema, Semaphore } from "effect"
import {
  canonicalJson, frameworkDraft, HarnessError, ModelCallData, ModelCallLegacyUsage, readStored, replayableContext,
  storedJson, turnModelCallsOf,
} from "@xandreed/core"
import type { ModelCallObserver, ModelCallRecorder, TurnError, TurnWriter } from "@xandreed/core"
import { CurrentModelCallNotifications, CurrentToolResultReceipt } from "@xandreed/core/internal"
import { ModelCallRecorderPhase } from "./model-call-recorder.entity.js"
import type { ObservedModelCall } from "./model-call-recorder.entity.js"
import { mergeModelCalls, modelCallKey } from "./model-call-recorder.entity.functions.js"

interface Observer {
  readonly listener: ModelCallObserver
  readonly context: Context.Context<never>
  readonly seen: Ref.Ref<ReadonlySet<string>>
}
interface Claim {
  readonly encoded: string
  readonly done: Deferred.Deferred<void, TurnError>
}
interface ClaimChoice { readonly _tag: "Own" | "Join"; readonly claim: Claim }
const invalid = (message: string, cause?: unknown) => new HarnessError({ code: "events.encode", message, ...(cause === undefined ? {} : { cause }) })
const CallText = Schema.fromJsonString(ModelCallData)
const LegacyText = Schema.fromJsonString(ModelCallLegacyUsage)
const LegacyListText = Schema.fromJsonString(Schema.Array(ModelCallLegacyUsage))
const copyCall = (data: ModelCallData) => Schema.encodeEffect(CallText)(data).pipe(Effect.flatMap(Schema.decodeUnknownEffect(CallText)))
const copyLegacy = (data: ReadonlyArray<ModelCallLegacyUsage>) => Schema.encodeEffect(LegacyListText)(data).pipe(Effect.flatMap(Schema.decodeUnknownEffect(LegacyListText)))

/** One writer owns durability; observers only see accepted terminal facts. */
export const makeTurnModelCallRecorder = Effect.fnUntraced(function* (
  writer: TurnWriter,
  publish: (data: ModelCallData) => Effect.Effect<void, TurnError>,
) {
  const before = yield* writer.snapshot(["model.called", "step.usage"])
  const seededCalls = yield* turnModelCallsOf(before, writer.admitted.turn).pipe(Effect.mapError((cause) => invalid("the turn's model-call ledger did not decode", cause)))
  const seededLegacy = yield* readStored("step.usage", before.filter((event) => Option.contains(event.turn, writer.admitted.turn))).pipe(
    Effect.map((records): ReadonlyArray<ModelCallLegacyUsage> => records.map(({ data }) => ({ model: data.model, usage: data.usage, replayed: true }))),
    Effect.mapError((cause) => invalid("the turn's selected usage did not decode", cause)),
  )
  const originalKeys = new Set(seededCalls.map(modelCallKey))
  const phase = yield* Ref.make<ModelCallRecorderPhase>({ _tag: "Open", calls: seededCalls.map((data) => ({ data, replayed: true })), legacy: seededLegacy })
  const claims = yield* Ref.make<ReadonlyMap<string, Claim>>(new Map())
  const observers = yield* Ref.make<ReadonlyArray<Observer>>([])
  // Orders snapshot/registration against accepted writes; callbacks run outside it.
  const order = yield* Semaphore.make(1)

  const deliver = (observer: Observer, call: ObservedModelCall): Effect.Effect<void> => Ref.modify(observer.seen, (seen) => {
    const key = modelCallKey(call.data)
    return seen.has(key) ? [false, seen] as const : [true, new Set([...seen, key])] as const
  }).pipe(Effect.flatMap((fresh) => fresh ? copyCall(call.data).pipe(
    Effect.orDie, Effect.flatMap((snapshot) => observer.listener.called(snapshot, { replayed: call.replayed })), Effect.provide(observer.context),
  ) : Effect.void), Effect.interruptible, Effect.ignoreCause({ log: "Warn", message: "a model-call billing observer failed" }))
  const deliverAll = (listeners: ReadonlyArray<Observer>, calls: ReadonlyArray<ObservedModelCall>) => Effect.forEach(listeners, (observer) =>
    Effect.forEach(calls, (call) => deliver(observer, call), { concurrency: 1, discard: true }), { concurrency: 1, discard: true })
  const reconcile = writer.snapshot(["model.called"]).pipe(
    Effect.flatMap((events) => turnModelCallsOf(events, writer.admitted.turn)),
    Effect.flatMap((calls) => Ref.update(phase, (current) => mergeModelCalls(current, calls.map((data) => ({ data, replayed: originalKeys.has(modelCallKey(data)) }))))),
    Effect.ignoreCause({ log: "Warn", message: "the model-call billing snapshot could not be refreshed" }),
  )

  const recorder: ModelCallRecorder = {
    record: Effect.fn("turn.record_model_call")(function* (data) {
      const encoded = yield* Schema.encodeEffect(ModelCallData)(data).pipe(
        Effect.flatMap(storedJson), Effect.mapError((cause) => invalid("model.called did not encode", cause)),
      )
      const fact = yield* Schema.decodeUnknownEffect(ModelCallData)(encoded).pipe(Effect.mapError((cause) => invalid("model.called did not decode", cause)))
      if (Option.exists(fact.runId, (runId) => runId !== writer.admitted.runId)) return yield* Effect.fail(invalid("model.called belongs to another admitted run"))
      const key = modelCallKey(fact)
      const text = canonicalJson(encoded)
      return yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        const done = yield* Deferred.make<void, TurnError>()
        const fresh: Claim = { encoded: text, done }
        const claim = yield* Ref.modify(claims, (all): readonly [ClaimChoice, ReadonlyMap<string, Claim>] => {
          const prior = all.get(key)
          return prior === undefined
            ? [{ _tag: "Own" as const, claim: fresh }, new Map([...all, [key, fresh]])] as const
            : [{ _tag: "Join" as const, claim: prior }, all] as const
        })
        if (claim.claim.encoded !== text) return yield* Effect.fail(invalid("model.called repeated a terminal key with different facts"))
        const notifying = yield* CurrentModelCallNotifications
        if (claim._tag === "Join") {
          if (notifying.has(claim.claim) && !(yield* Deferred.isDone(claim.claim.done))) return yield* Effect.fail(new HarnessError({ code: "events.depth", message: "model.called cannot re-enter its own terminal recording notification" }))
          return yield* Deferred.await(claim.claim.done).pipe(Effect.interruptible)
        }
        const operation: Effect.Effect<void, TurnError> = Effect.gen(function* () {
          const listeners = yield* order.withPermits(1)(Effect.uninterruptible(Effect.gen(function* (): Effect.fn.Return<Option.Option<ReadonlyArray<Observer>>, TurnError> {
            const current = yield* Ref.get(phase)
            if (ModelCallRecorderPhase.guards.Closed(current)) return yield* Effect.fail(new HarnessError({ code: "turn.closed", message: "the model-call recorder's owner is closed" }))
            // Existing durable facts retain their ACK, including across a resumed TurnLive.
            const existing = current.calls.find((call) => modelCallKey(call.data) === key)
            if (existing !== undefined) {
              const known = yield* Schema.encodeEffect(ModelCallData)(existing.data).pipe(Effect.flatMap(storedJson), Effect.mapError((cause) => invalid("model.called did not encode", cause)))
              if (canonicalJson(known) !== text) return yield* Effect.fail(invalid("model.called repeated a durable key with different facts"))
              return Option.none()
            }
            yield* writer.append([frameworkDraft("model.called", encoded)])
            yield* writer.flush
            yield* Ref.update(phase, (state) => ({ ...state, calls: [...state.calls, { data: fact, replayed: false }] }))
            return Option.some(yield* Ref.get(observers))
          })))
          // Explicitly interruptible even if a provider's terminal finalizer
          // called record under a mask. Arbitrary reactions never inherit it.
          yield* Option.match(listeners, {
            onNone: () => Effect.void,
            onSome: (all) => deliverAll(all, [{ data: fact, replayed: false }]).pipe(
              Effect.andThen(copyCall(fact).pipe(Effect.mapError((cause) => invalid("model.called notification did not encode", cause)), Effect.flatMap(publish))),
              Effect.provideService(CurrentModelCallNotifications, new Set([...notifying, claim.claim])),
              Effect.interruptible,
            ),
          })
        })
        const exit = yield* Effect.exit(restore(operation))
        yield* Deferred.done(claim.claim.done, exit)
        return yield* exit
      }))
    }),
    observe: Effect.fn("turn.observe_model_calls")(function* (listener) {
      const observer: Observer = { listener, context: Context.omit(CurrentModelCallNotifications, CurrentToolResultReceipt)(replayableContext(yield* Effect.context<never>())), seen: yield* Ref.make<ReadonlySet<string>>(new Set()) }
      const current = yield* order.withPermits(1)(Effect.gen(function* () {
        yield* reconcile
        const current = yield* Ref.get(phase)
        if (ModelCallRecorderPhase.guards.Open(current)) yield* Ref.update(observers, (all) => [...all, observer])
        return current
      }))
      yield* deliverAll([observer], current.calls)
      if (ModelCallRecorderPhase.guards.Closed(current)) yield* copyLegacy(current.legacy).pipe(Effect.orDie, Effect.flatMap(listener.closed), Effect.provide(observer.context), Effect.ignoreCause({ log: "Warn", message: "a model-call billing observer failed to close" }))
    }),
  }
  const close = yield* Effect.cached(Effect.gen(function* () {
    const ending = yield* order.withPermits(1)(Effect.gen(function* () {
      yield* reconcile
      const current = yield* Ref.get(phase)
      const closed: ModelCallRecorderPhase = { ...current, _tag: "Closed" }
      yield* Ref.set(phase, closed)
      return { current, listeners: yield* Ref.get(observers) }
    }))
    yield* deliverAll(ending.listeners, ending.current.calls)
    yield* Effect.forEach(ending.listeners, (observer) => copyLegacy(ending.current.legacy).pipe(Effect.orDie, Effect.flatMap(observer.listener.closed),
      Effect.provide(observer.context), Effect.ignoreCause({ log: "Warn", message: "a model-call billing observer failed to close" }),
    ), { concurrency: 1, discard: true })
  }))
  return {
    recorder,
    close,
    legacy: (data: ModelCallLegacyUsage) => Schema.encodeEffect(LegacyText)(data).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(LegacyText)), Effect.mapError((cause) => invalid("selected usage did not encode", cause)),
      Effect.flatMap((snapshot) => Ref.update(phase, (current) => ModelCallRecorderPhase.guards.Open(current) ? { ...current, legacy: [...current.legacy, snapshot] } : current)),
    ),
  }
})
