// The hold-and-settle lifecycle over the kernel's scripted model, before any wire: a shared ledger refusing a call,
// a call settled at what it reported, a stream cut and a call interrupted settled at the hold, a call that never
// left released, and every hold closed.
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Option, Ref, Stream } from "effect"
import { LanguageModel } from "effect/ai"
import { ModelSpend, modelSpendMemory } from "@xandreed/core/kernel"
import { scriptedModel } from "../../index.js"
import type { ModelScript } from "../../index.js"
import { CallReach } from "./call-reach.port.js"
import { chargedEffect, chargedStream } from "./charge.adapter.js"
import type { Charging } from "./charge.adapter.js"
import { isSpendRefusal, spendRefusalOf } from "./model-spend.entity.functions.js"
import type { Charge, Reach, SpendOptions } from "./model-spend.entity.js"

const price = { input: 1, output: 2 }
const hold = (amount: number): Charge => ({ _tag: "Held", amount, price })
/** What the stand-in provider bills for every whole answer. */
const BILLED = 0.001

/** Mark the call's request as having reached `reach`, as a provider's client does as it sends. */
const reached = (reach: Reach) => Stream.fromEffect(Effect.flatMap(CallReach, (cell) => Ref.set(cell, reach))).pipe(Stream.drain)

/**
 * One call of the scripted model, charged against the ledger in context: the request "leaves" first (unless
 * `unsent`), and the finish part's usage is what the provider reports.
 */
const call = (charge: Charge, options: SpendOptions = { prices: {} }, unsent = false) => Effect.gen(function* () {
  const charging: Charging = { spend: yield* ModelSpend, options, model: "scripted", module: "Scripted" }
  const model = yield* LanguageModel.LanguageModel
  return chargedStream(charging, "streamText", charge, (report) => Stream.concat(
    unsent ? Stream.empty : reached("Sent"),
    model.streamText({ prompt: "Hi" }).pipe(Stream.tap((part) => part.type === "finish"
      ? report({ input: part.usage.inputTokens.total ?? 0, output: part.usage.outputTokens.total ?? 0, cacheRead: 0, cacheWrite: 0, billed: BILLED })
      : Effect.void)),
  ))
})

/** Run `body` over a fresh ledger and the scripted model; give its outcome, the ledger's totals and what the model was sent. */
const over = <A, E>(script: ModelScript, body: Effect.Effect<A, E, ModelSpend | LanguageModel.LanguageModel>) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { model, calls } = yield* scriptedModel(script)
    return yield* Effect.gen(function* () {
      const outcome = yield* Effect.result(body)
      return { outcome, totals: yield* (yield* ModelSpend).totals, calls: (yield* calls).length }
    }).pipe(Effect.provide(model), Effect.provide(modelSpendMemory))
  })))

const answer: ModelScript = [{ _tag: "Answers", pieces: ["Hel", "lo"] }]

describe("a call's hold", () => {
  test("is settled at what the provider reported once the answer is whole", async () => {
    const run = await over(answer, Effect.flatMap(call(hold(0.02)), Stream.runCollect))
    expect(run.outcome._tag).toBe("Success")
    expect(run.totals).toEqual({ settled: 0.001, reserved: 0 })
  })

  test("is held while the answer streams, and closed when it ends", async () => {
    const run = await over(answer, Effect.gen(function* () {
      const reading = yield* Deferred.make<void>()
      const go = yield* Deferred.make<void>()
      const stream = yield* call(hold(0.02))
      const fiber = yield* stream.pipe(Stream.tap(() => Deferred.succeed(reading, undefined).pipe(Effect.andThen(Deferred.await(go)))), Stream.runDrain, Effect.forkChild)
      yield* Deferred.await(reading)
      const during = yield* (yield* ModelSpend).totals
      yield* Deferred.succeed(go, undefined)
      yield* Fiber.join(fiber)
      return during
    }))
    expect(run.outcome).toMatchObject({ _tag: "Success", success: { settled: 0, reserved: 0.02 } })
    expect(run.totals).toEqual({ settled: 0.001, reserved: 0 })
  })

  test("is refused by a shared ledger over its cap: nothing is sent, the call fails with the ledger's refusal, and nothing is held", async () => {
    const run = await over(answer, Effect.gen(function* () {
      const options: SpendOptions = { prices: {}, caps: { total: 0.05 } }
      yield* Effect.flatMap(call(hold(0.03), options), Stream.runDrain)
      return yield* Effect.flatMap(call(hold(0.05), options), Stream.runDrain)
    }))
    expect(run.calls).toBe(1)
    expect(run.totals).toEqual({ settled: 0.001, reserved: 0 })
    const error = run.outcome._tag === "Failure" ? run.outcome.failure : undefined
    expect(isSpendRefusal(error)).toBe(true)
    expect(Option.map(spendRefusalOf(error), (refusal) => [refusal.reason, refusal.cap, refusal.committed, refusal.requested])).toEqual(Option.some(["total", 0.05, 0.001, 0.05]))
  })

  test("is settled at the amount held when the stream is cut after the request left", async () => {
    const run = await over([{ _tag: "Fails", retryable: true, pieces: ["Hel"] }], Effect.flatMap(call(hold(0.02)), Stream.runDrain))
    expect(run.outcome._tag).toBe("Failure")
    expect(run.totals).toEqual({ settled: 0.02, reserved: 0 })
  })

  test("is settled at the amount held when the call is interrupted after the request left", async () => {
    const run = await over(answer, Effect.gen(function* () {
      const reading = yield* Deferred.make<void>()
      const stream = yield* call(hold(0.02))
      const fiber = yield* stream.pipe(Stream.tap(() => Deferred.succeed(reading, undefined).pipe(Effect.andThen(Effect.never))), Stream.runDrain, Effect.forkChild)
      yield* Deferred.await(reading)
      yield* Fiber.interrupt(fiber)
    }))
    expect(run.outcome._tag).toBe("Success")
    expect(run.totals).toEqual({ settled: 0.02, reserved: 0 })
  })

  test("is released when the call failed before its request left", async () => {
    const run = await over([{ _tag: "Fails" }], Effect.flatMap(call(hold(0.02), { prices: {} }, true), Stream.runDrain))
    expect(run.outcome._tag).toBe("Failure")
    expect(run.totals).toEqual({ settled: 0, reserved: 0 })
  })

  test("is released when the call is interrupted before its request left", async () => {
    const run = await over(answer, Effect.gen(function* () {
      const spend = yield* ModelSpend
      const charging: Charging = { spend, options: { prices: {} }, model: "scripted", module: "Scripted" }
      const taken = yield* Deferred.make<void>()
      const fiber = yield* chargedEffect(charging, "generateText", hold(0.02), () => Deferred.succeed(taken, undefined).pipe(Effect.andThen(Effect.never))).pipe(Effect.forkChild)
      yield* Deferred.await(taken)
      const during = yield* spend.totals
      yield* Fiber.interrupt(fiber)
      return during
    }))
    expect(run.outcome).toMatchObject({ _tag: "Success", success: { reserved: 0.02 } })
    expect(run.totals).toEqual({ settled: 0, reserved: 0 })
  })
})
