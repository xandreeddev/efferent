import { describe, expect, test } from "bun:test"
import { Array as Arr, Effect, Order, Ref } from "effect"
import { makeModelSpendMemory } from "./model-spend.adapter.js"
import { modelSpendConformance } from "./model-spend.conformance.js"
import type { ModelSpendSubject } from "./model-spend.conformance.js"
import { ModelSpendExceeded, SpendHoldId } from "./model-spend.entity.js"
import type { SpendHold } from "./model-spend.entity.js"
import { ModelSpend } from "./model-spend.port.js"

/*
 * The kit over the kernel's ledger in memory, which passes it, and over careless ledgers, each failing the checks of
 * the promise it breaks and no other.
 */

const honest: ModelSpendSubject = { open: makeModelSpendMemory }

/** The honest ledger with some of its methods replaced. */
const changed = (change: (ledger: ModelSpend["Service"]) => Partial<ModelSpend["Service"]>): ModelSpendSubject => ({
  open: Effect.map(makeModelSpendMemory, (ledger) => ModelSpend.of({ ...ledger, ...change(ledger) })),
})

/** A ledger that holds whatever it is asked, whatever the cap. */
const capless = changed((ledger) => ({ reserve: (request) => ledger.reserve({ ...request, caps: {} }) }))

/** A ledger whose settlement counts nothing: a settled hold is released. */
const unsettled = changed((ledger) => ({ settle: (hold) => ledger.release(hold) }))

/** A ledger with a ceiling of its own: it refuses any reservation over 100, whatever the request's caps say. */
const ceiling = changed((ledger) => ({ reserve: (request) => ledger.reserve({ ...request, caps: { total: Math.min(request.caps.total ?? 100, 100) } }) }))

/** A ledger whose release settles the amount held, as if the call had cost it all. */
const billing = changed((ledger) => ({ release: (hold) => ledger.settle(hold, hold.amount) }))

/** A ledger that settles a hold each time it is told to, closed or not. */
const repeating: ModelSpendSubject = {
  open: Effect.gen(function* () {
    const ledger = yield* makeModelSpendMemory
    const extra = yield* Ref.make(0)
    const closed = yield* Ref.make<ReadonlySet<string>>(new Set())
    const totals = Effect.zipWith(ledger.totals, Ref.get(extra), (totals, more) => ({ ...totals, settled: totals.settled + more }))
    return ModelSpend.of({
      ...ledger,
      settle: (hold, cost) => Effect.flatMap(Ref.get(closed), (done) => done.has(hold.id)
        ? Ref.update(extra, (more) => more + cost)
        : Effect.andThen(ledger.settle(hold, cost), Ref.update(closed, (all) => new Set([...all, hold.id])))),
      release: (hold) => Effect.andThen(ledger.release(hold), Ref.update(closed, (all) => new Set([...all, hold.id]))),
      totals,
    })
  }),
}

/** A ledger that reads its holds, waits, then writes: two reservations at once can both pass the cap. */
const racy: ModelSpendSubject = {
  open: Effect.gen(function* () {
    const holds = yield* Ref.make<ReadonlyArray<SpendHold>>([])
    const settled = yield* Ref.make(0)
    const minted = yield* Ref.make(0)
    const totals = Effect.zipWith(Ref.get(settled), Ref.get(holds), (done, open) => ({ settled: done, reserved: open.reduce((sum, hold) => sum + hold.amount, 0) }))
    return ModelSpend.of({
      reserve: (request) => Effect.gen(function* () {
        const before = yield* totals
        yield* Effect.yieldNow
        const cap = request.caps.total
        if (cap !== undefined && before.settled + before.reserved + request.amount > cap) {
          return yield* Effect.fail(new ModelSpendExceeded({ reason: "total", cap, committed: before.settled + before.reserved, requested: request.amount, message: "past the cap" }))
        }
        const id = SpendHoldId.make(`h${yield* Ref.updateAndGet(minted, (n) => n + 1)}`)
        const hold = { id, amount: request.amount }
        yield* Ref.update(holds, (open) => [...open, hold])
        return hold
      }),
      settle: (hold, cost) => Effect.flatMap(Ref.get(holds), (open) => open.some((one) => one.id === hold.id)
        ? Effect.andThen(Ref.update(holds, (all) => all.filter((one) => one.id !== hold.id)), Ref.update(settled, (done) => done + cost))
        : Effect.void),
      release: (hold) => Ref.update(holds, (all) => all.filter((one) => one.id !== hold.id)),
      totals,
    })
  }),
}

/** A ledger that names a hold by its amount, so two holds of one amount share an id, and closing one closes both. */
const byAmount: ModelSpendSubject = {
  open: Effect.gen(function* () {
    const holds = yield* Ref.make<ReadonlyArray<SpendHold>>([])
    const settled = yield* Ref.make(0)
    const totals = Effect.zipWith(Ref.get(settled), Ref.get(holds), (done, open) => ({ settled: done, reserved: open.reduce((sum, hold) => sum + hold.amount, 0) }))
    const close = (hold: SpendHold, cost: number) => Effect.flatMap(Ref.modify(holds, (open) => [open.some((one) => one.id === hold.id), open.filter((one) => one.id !== hold.id)] as const),
      (had) => had ? Ref.update(settled, (done) => done + cost) : Effect.void)
    return ModelSpend.of({
      reserve: (request) => Effect.flatMap(Ref.get(settled), (done) => Effect.flatten(Ref.modify(holds, (open): readonly [Effect.Effect<SpendHold, ModelSpendExceeded>, ReadonlyArray<SpendHold>] => {
        const committed = done + open.reduce((sum, hold) => sum + hold.amount, 0)
        const cap = request.caps.total
        if (cap !== undefined && committed + request.amount > cap) return [Effect.fail(new ModelSpendExceeded({ reason: "total", cap, committed, requested: request.amount, message: "past the cap" })), open] as const
        const hold = { id: SpendHoldId.make(`h${request.amount}`), amount: request.amount }
        return [Effect.succeed(hold), [...open, hold]] as const
      }))),
      settle: close,
      release: (hold) => close(hold, 0),
      totals,
    })
  }),
}

/** The ids of the checks that fail; a failure that names another check than the one it came from is told apart. */
const failedChecks = (subject: ModelSpendSubject) => Effect.runPromise(Effect.forEach(modelSpendConformance(subject), (check) =>
  Effect.result(check.run).pipe(Effect.map((result) => result._tag === "Failure" ? [result.failure.check === check.id ? check.id : `${check.id} reported as ${result.failure.check}`] : [])),
{ concurrency: 1 })).then((failed) => Arr.sort(failed.flat(), Order.String))

describe("the model spend kit", () => {
  test("its checks have the ids its doc comment lists, in that order", () => {
    expect(modelSpendConformance(honest).map((check) => check.id)).toEqual(["reserve", "total-cap", "settle", "release", "repeat", "concurrent", "uncapped"])
  })

  test("the ledger kept in memory passes every check", async () => {
    expect(await failedChecks(honest)).toEqual([])
  })

  test("a ledger that ignores the cap fails the checks of the cap, of settled spend under it and of reservations made at once", async () => {
    expect(await failedChecks(capless)).toEqual(["concurrent", "settle", "total-cap"])
  })

  test("a ledger with a ceiling of its own fails the check of no cap", async () => {
    expect(await failedChecks(ceiling)).toEqual(["uncapped"])
  })

  test("a ledger whose settlement counts nothing fails the checks of a settlement and of a repeat", async () => {
    expect(await failedChecks(unsettled)).toEqual(["repeat", "settle"])
  })

  test("a ledger whose release settles what was held fails the checks of a release and of a repeat", async () => {
    expect(await failedChecks(billing)).toEqual(["release", "repeat"])
  })

  test("a ledger that settles a closed hold again fails the check of a repeat", async () => {
    expect(await failedChecks(repeating)).toEqual(["repeat"])
  })

  test("a ledger whose reservation is no single step fails the check of reservations made at once", async () => {
    expect(await failedChecks(racy)).toEqual(["concurrent"])
  })

  // Its repeat check passes: closing either of its two holds of one amount closes both, which leaves the same totals.
  test("a ledger whose holds of one amount share an id fails the checks of a reservation and of reservations made at once", async () => {
    expect(await failedChecks(byAmount)).toEqual(["concurrent", "reserve"])
  })
})
