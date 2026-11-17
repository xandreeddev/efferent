import { Effect, Result } from "effect"
import type { Context, Scope } from "effect"
import { expect, fail, show, unexpected } from "./conformance.entity.functions.js"
import type { ConformanceCheck } from "./conformance.entity.js"
import type { SpendCaps, SpendHold, SpendTotals } from "./model-spend.entity.js"
import type { ModelSpend } from "./model-spend.port.js"

type ModelSpendShape = Context.Service.Shape<typeof ModelSpend>

/**
 * A ledger as the kit opens it: an empty one per check, released with its scope.
 *
 * @public
 */
export interface ModelSpendSubject {
  readonly open: Effect.Effect<ModelSpendShape, never, Scope.Scope>
}

const totalsAre = (totals: SpendTotals, settled: number, reserved: number): boolean => totals.settled === settled && totals.reserved === reserved
const shown = (totals: SpendTotals): string => `settled ${totals.settled}, reserved ${totals.reserved}`

/** A check over a fresh ledger; a failure of the ledger it did not expect fails it, in the failure's words. */
const over = (
  subject: ModelSpendSubject,
  id: string,
  name: string,
  body: (ledger: ModelSpendShape) => Effect.Effect<void, { readonly _tag: string; readonly message: string }>,
): ConformanceCheck => ({ id, name, run: unexpected(id)(Effect.scoped(Effect.flatMap(subject.open, body))) })

/**
 * The `ModelSpend` contract as checks, each over an empty ledger: a reservation is held and counted as reserved
 * under an id no other hold has (`reserve`); one past the total cap is refused, names the cap, what was committed and what was asked for, and
 * holds nothing (`total-cap`); settling closes a hold at the observed cost, below or above what it held, and settled
 * spend counts toward the cap (`settle`); releasing settles nothing and frees the amount (`release`); closing a hold
 * again changes nothing (`repeat`); reservations made at once never pass a cap together (`concurrent`); with no cap,
 * anything is held (`uncapped`). Amounts are binary fractions, so a ledger may sum them as plain numbers.
 *
 * @public
 */
export const modelSpendConformance = (subject: ModelSpendSubject): ReadonlyArray<ConformanceCheck> => [
  over(subject, "reserve", "a reservation is held under an id of its own, and counted as reserved", (ledger) => Effect.gen(function* () {
    const hold = yield* ledger.reserve({ amount: 1.5, caps: { total: 8 } })
    yield* expect("reserve", hold.amount === 1.5 && hold.id.length > 0, `the hold does not carry the amount asked for: ${show(hold)}`)
    const other = yield* ledger.reserve({ amount: 1.5, caps: {} })
    yield* expect("reserve", other.id !== hold.id, "two holds have one id")
    const totals = yield* ledger.totals
    yield* expect("reserve", totalsAre(totals, 0, 3), `held reservations are not counted as reserved (${shown(totals)})`)
  })),
  over(subject, "total-cap", "a reservation past the total cap is refused and holds nothing", (ledger) => Effect.gen(function* () {
    const caps: SpendCaps = { total: 3 }
    yield* ledger.reserve({ amount: 2, caps })
    const refused = yield* Effect.result(ledger.reserve({ amount: 1.5, caps }))
    yield* Result.match(refused, {
      onSuccess: () => fail("total-cap", "a reservation past the total cap was held"),
      onFailure: (error) => expect("total-cap", error._tag === "ModelSpendExceeded" && error.reason === "total" && error.cap === 3 && error.committed === 2 && error.requested === 1.5,
        `the refusal does not name the cap, what was committed and what was asked for: ${show(error)}`),
    })
    const totals = yield* ledger.totals
    yield* expect("total-cap", totalsAre(totals, 0, 2), `a refused reservation was held (${shown(totals)})`)
    const fits = yield* Effect.result(ledger.reserve({ amount: 1, caps }))
    yield* expect("total-cap", Result.isSuccess(fits), "a reservation that reaches the cap exactly was refused")
  })),
  over(subject, "settle", "settling closes a hold at the observed cost, below or above the amount held", (ledger) => Effect.gen(function* () {
    const caps: SpendCaps = { total: 4 }
    const first = yield* ledger.reserve({ amount: 2, caps })
    const second = yield* ledger.reserve({ amount: 1, caps })
    yield* ledger.settle(first, 0.5)
    yield* ledger.settle(second, 1.25)
    const totals = yield* ledger.totals
    yield* expect("settle", totalsAre(totals, 1.75, 0), `settled costs are not what the calls cost (${shown(totals)})`)
    const fits = yield* Effect.result(ledger.reserve({ amount: 2.25, caps }))
    const past = yield* Effect.result(ledger.reserve({ amount: 0.25, caps }))
    yield* expect("settle", Result.isSuccess(fits) && Result.isFailure(past), "settled spend does not count toward the cap")
  })),
  over(subject, "release", "releasing a hold settles nothing and frees its amount", (ledger) => Effect.gen(function* () {
    const caps: SpendCaps = { total: 2 }
    const hold = yield* ledger.reserve({ amount: 2, caps })
    yield* ledger.release(hold)
    const totals = yield* ledger.totals
    yield* expect("release", totalsAre(totals, 0, 0), `a released hold is still counted (${shown(totals)})`)
    const again = yield* Effect.result(ledger.reserve({ amount: 2, caps }))
    yield* expect("release", Result.isSuccess(again), "a released hold's amount could not be reserved again")
  })),
  over(subject, "repeat", "closing a hold again changes nothing", (ledger) => Effect.gen(function* () {
    const settled = yield* ledger.reserve({ amount: 1, caps: {} })
    const released = yield* ledger.reserve({ amount: 1, caps: {} })
    yield* ledger.settle(settled, 0.5)
    yield* ledger.release(released)
    yield* ledger.settle(settled, 0.5)
    yield* ledger.release(settled)
    yield* ledger.settle(released, 1)
    yield* ledger.release(released)
    const totals = yield* ledger.totals
    yield* expect("repeat", totalsAre(totals, 0.5, 0), `a closed hold was closed again (${shown(totals)})`)
  })),
  over(subject, "concurrent", "reservations made at once never take the spend past a cap", (ledger) => Effect.gen(function* () {
    const results = yield* Effect.forEach(Array.from({ length: 24 }, (_, index) => index), () =>
      Effect.result(ledger.reserve({ amount: 0.5, caps: { total: 4 } })), { concurrency: "unbounded" })
    const held: ReadonlyArray<SpendHold> = results.flatMap((result) => Result.isSuccess(result) ? [result.success] : [])
    const totals = yield* ledger.totals
    yield* expect("concurrent", held.length === 8 && new Set(held.map((hold) => hold.id)).size === 8 && totalsAre(totals, 0, 4),
      `${held.length} of 24 reservations made at once were held under a cap for 8, or two shared an id (${shown(totals)})`)
  })),
  over(subject, "uncapped", "without a cap anything is held", (ledger) => Effect.gen(function* () {
    yield* ledger.reserve({ amount: 1_000_000, caps: {} })
    const totals = yield* ledger.totals
    yield* expect("uncapped", totalsAre(totals, 0, 1_000_000), `an uncapped reservation was not held as asked (${shown(totals)})`)
  })),
]
