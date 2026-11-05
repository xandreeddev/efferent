import { expect, test } from "bun:test"
import { Context, Deferred, Effect, Fiber, Layer, Option } from "effect"
import { ModelSpend, ModelSpendMemoryLive, RunId } from "@xandreed/core"
import type { SpendHold } from "@xandreed/core"
import { modelSpendConformance } from "@xandreed/core/conformance"
import { runSpendLedger } from "./run-spend.adapter.js"

/** A fresh run's ledger over an in-memory `ModelSpend`, within `budget`. */
const openRun = (budget: Option.Option<number>) =>
  Layer.build(Layer.fresh(ModelSpendMemoryLive)).pipe(
    Effect.flatMap((context) => runSpendLedger(Context.get(context, ModelSpend), budget)),
  )

// A trial's account is a `ModelSpend` ledger: without a budget, or under one
// above every amount the kit asks for, it keeps the whole contract.
test.each([
  ...modelSpendConformance({ open: () => openRun(Option.none()).pipe(Effect.flatMap((run) => run.trial), Effect.map((account) => account.ledger)) })
    .map((check) => ({ ...check, name: `uncapped: ${check.name}` })),
  ...modelSpendConformance({ open: () => openRun(Option.some(10_000_000)).pipe(Effect.flatMap((run) => run.trial), Effect.map((account) => account.ledger)) })
    .map((check) => ({ ...check, name: `under a budget: ${check.name}` })),
])("trial account: $name", async (check) => {
  await Effect.runPromise(check.run)
})

test("trials share the run's ledger and budget, each settling apart, and a refusal under the budget stops the run", async () => {
  const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const run = yield* openRun(Option.some(2))
    const first = yield* run.trial
    const second = yield* run.trial
    const unused = yield* run.trial
    const a = yield* first.ledger.reserve({ amount: 1, caps: {} })
    const b = yield* second.ledger.reserve({ runId: RunId.make("turn"), amount: 0.5, caps: { turn: 4 } })
    yield* first.ledger.settle(a, 0.75)
    // Closing a hold again, or another account's hold, counts nothing.
    yield* first.ledger.settle(a, 0.75)
    yield* first.ledger.settle(b, 0.25)
    yield* second.ledger.settle(b, 0.25)
    const beforeRefusal = yield* run.stopped
    const refusal = yield* Effect.flip(second.ledger.reserve({ amount: 1.5, caps: {} }))
    return {
      beforeRefusal,
      refusal: [refusal._tag, refusal._tag === "ModelSpendExceeded" ? refusal.reason : "", refusal._tag === "ModelSpendExceeded" ? refusal.cap : 0],
      first: yield* first.spend,
      second: yield* second.spend,
      unused: yield* unused.spend,
      refusals: [yield* first.refusal, yield* second.refusal],
      stopped: yield* run.stopped,
      totals: yield* run.totals,
    }
  })))
  expect(observed.beforeRefusal).toEqual(Option.none())
  expect(observed.refusal).toEqual(["ModelSpendExceeded", "total", 2])
  expect(observed.first).toEqual(Option.some({ settled: 0.75 }))
  expect(observed.second).toEqual(Option.some({ settled: 0.25 }))
  expect(observed.unused).toEqual(Option.none())
  expect(observed.refusals[0]).toEqual(Option.none())
  expect(Option.map(observed.refusals[1]!, (message) => message.startsWith("the total model spend cap of 2"))).toEqual(Option.some(true))
  expect(observed.stopped).toEqual(observed.refusals[1]!)
  expect(observed.totals).toEqual({ settled: 1, reserved: 0 })
})

test("a refusal under a turn's own cap is the trial's, and never stops the run", async () => {
  const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const run = yield* openRun(Option.some(10))
    const account = yield* run.trial
    const refusal = yield* Effect.flip(account.ledger.reserve({ runId: RunId.make("turn"), amount: 2, caps: { turn: 1 } }))
    return { reason: refusal._tag === "ModelSpendExceeded" ? refusal.reason : refusal._tag, refusal: yield* account.refusal, spend: yield* account.spend, stopped: yield* run.stopped }
  })))
  expect(observed).toEqual({ reason: "turn", refusal: Option.none(), spend: Option.some({ settled: 0 }), stopped: Option.none() })
})

test("what the trials settle reaching the budget stops the run, though nothing was refused", async () => {
  const stopped = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const run = yield* openRun(Option.some(1))
    const account = yield* run.trial
    const hold = yield* account.ledger.reserve({ amount: 0.5, caps: {} })
    yield* account.ledger.settle(hold, 1.25)
    return yield* run.stopped
  })))
  expect(stopped).toEqual(Option.some("the run's spend budget of 1 is reached: 1.25 is settled"))
})

test("an interruption that lands while the shared ledger takes a hold leaves the hold in the trial's account, so its settlement counts", async () => {
  const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const inner = Context.get(yield* Layer.build(Layer.fresh(ModelSpendMemoryLive)), ModelSpend)
    const taken = yield* Deferred.make<SpendHold>()
    const answer = yield* Deferred.make<void>()
    // A shared ledger whose reply is still on its way once it has taken the hold.
    const slow = ModelSpend.of({ ...inner, reserve: (request) => inner.reserve(request).pipe(Effect.tap((hold) => Deferred.succeed(taken, hold)), Effect.tap(() => Deferred.await(answer))) })
    const run = yield* runSpendLedger(slow, Option.none())
    const account = yield* run.trial
    const reserving = yield* Effect.forkChild(account.ledger.reserve({ amount: 1, caps: {} }))
    const hold = yield* Deferred.await(taken)
    const interrupting = yield* Effect.forkChild(Fiber.interrupt(reserving), { startImmediately: true })
    yield* Deferred.succeed(answer, undefined)
    yield* Fiber.join(interrupting)
    yield* account.ledger.settle(hold, 0.5)
    return { spend: yield* account.spend, totals: yield* run.totals }
  })))
  expect(observed).toEqual({ spend: Option.some({ settled: 0.5 }), totals: { settled: 0.5, reserved: 0 } })
})
