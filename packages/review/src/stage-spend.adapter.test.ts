import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Option, Ref } from "effect"
import { ModelSpend, modelSpendMemory } from "@xandreed/core"
import { stageSpend } from "./stage-spend.adapter.js"

/** Run with the review's ledger in memory as the parent. */
const run = <A, E>(body: Effect.Effect<A, E, ModelSpend>) => Effect.runPromise(body.pipe(Effect.provide(modelSpendMemory)))

describe("stageSpend", () => {
  test("a hold is the stage's and the parent's; settling closes both, at the cost", async () => {
    const totals = await run(Effect.gen(function* () {
      const parent = yield* ModelSpend
      const stage = yield* stageSpend(parent, Option.some(1))
      const hold = yield* stage.reserve({ amount: 0.5, caps: {} })
      const held = [yield* stage.totals, yield* parent.totals]
      yield* stage.settle(hold, 0.25)
      yield* stage.settle(hold, 0.25)
      return [...held, yield* stage.totals, yield* parent.totals]
    }))
    expect(totals).toEqual([{ settled: 0, reserved: 0.5 }, { settled: 0, reserved: 0.5 }, { settled: 0.25, reserved: 0 }, { settled: 0.25, reserved: 0 }])
  })

  test("what settled spend leaves no room for is refused, naming the stage's cap; nothing is held", async () => {
    const exit = await run(Effect.gen(function* () {
      const parent = yield* ModelSpend
      const stage = yield* stageSpend(parent, Option.some(1))
      yield* stage.settle(yield* stage.reserve({ amount: 0.75, caps: {} }), 0.75)
      const refused = yield* Effect.exit(stage.reserve({ amount: 0.5, caps: {} }))
      return { refused, totals: yield* parent.totals }
    }))
    expect(Exit.isFailure(exit.refused) && JSON.stringify(exit.refused.cause).includes("ModelSpendExceeded")).toBe(true)
    expect(JSON.stringify(exit.refused)).toContain("the stage's model spend cap of 1 would be passed: 0.75 is settled or held, 0.5 more was asked for")
    expect(exit.totals).toEqual({ settled: 0.75, reserved: 0 })
  })

  test("a call the stage's open holds crowd out waits until one closes, then is held", async () => {
    const order = await run(Effect.gen(function* () {
      const parent = yield* ModelSpend
      const stage = yield* stageSpend(parent, Option.some(1))
      const first = yield* stage.reserve({ amount: 0.75, caps: {} })
      const held = yield* Ref.make(false)
      const second = yield* Effect.forkChild(Effect.tap(stage.reserve({ amount: 0.5, caps: {} }), () => Ref.set(held, true)))
      yield* Effect.yieldNow
      const waiting = [!(yield* Ref.get(held)), (yield* stage.totals).reserved]
      yield* stage.settle(first, 0.25)
      const hold = yield* Fiber.join(second)
      return [...waiting, hold.amount, yield* stage.totals]
    }))
    expect(order).toEqual([true, 0.75, 0.5, { settled: 0.25, reserved: 0.5 }])
  })

  test("a waiting call that is interrupted holds nothing", async () => {
    const totals = await run(Effect.gen(function* () {
      const parent = yield* ModelSpend
      const stage = yield* stageSpend(parent, Option.some(1))
      yield* stage.reserve({ amount: 0.75, caps: {} })
      const started = yield* Deferred.make<void>()
      const waiting = yield* Effect.forkChild(Effect.andThen(Deferred.succeed(started, undefined), stage.reserve({ amount: 0.5, caps: {} })))
      yield* Deferred.await(started)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(waiting)
      return [yield* stage.totals, yield* parent.totals]
    }))
    expect(totals).toEqual([{ settled: 0, reserved: 0.75 }, { settled: 0, reserved: 0.75 }])
  })

  test("a parent's refusal frees what the stage claimed", async () => {
    const totals = await run(Effect.gen(function* () {
      const parent = yield* ModelSpend
      const stage = yield* stageSpend(parent, Option.none())
      const refused = yield* Effect.exit(stage.reserve({ amount: 2, caps: { total: 1 } }))
      return [Exit.isFailure(refused), yield* stage.totals]
    }))
    expect(totals).toEqual([true, { settled: 0, reserved: 0 }])
  })

  test("releasing frees the hold and settles nothing", async () => {
    const totals = await run(Effect.gen(function* () {
      const parent = yield* ModelSpend
      const stage = yield* stageSpend(parent, Option.some(1))
      yield* stage.release(yield* stage.reserve({ amount: 0.5, caps: {} }))
      return [yield* stage.totals, yield* parent.totals]
    }))
    expect(totals).toEqual([{ settled: 0, reserved: 0 }, { settled: 0, reserved: 0 }])
  })
})
