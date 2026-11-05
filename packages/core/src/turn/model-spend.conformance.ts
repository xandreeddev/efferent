import { Effect, Option, Result } from "effect"
import type { Scope } from "effect"
import { check, expect } from "../conformance.functions.js"
import type { ConformanceCheck } from "../conformance.entity.js"
import type { SpendCaps, SpendHold, SpendTotals } from "../domain/model-spend.entity.js"
import { RunId } from "../domain/run.entity.js"
import type { ModelSpend } from "../ports/model-spend.port.js"

/**
 * How the `ModelSpend` kit reaches a ledger: `open` gives a ledger that
 * holds and has settled nothing, for each check.
 *
 * @public
 */
export interface ModelSpendSubject {
  readonly open: () => Effect.Effect<ModelSpend["Service"], unknown, Scope.Scope>
}

const totalsAre = (totals: SpendTotals, settled: number, reserved: number): boolean => totals.settled === settled && totals.reserved === reserved
const shown = (totals: SpendTotals): string => `settled ${totals.settled}, reserved ${totals.reserved}`

/**
 * The `ModelSpend` contract as runnable checks: reservations within the
 * turn and total caps, refusals that hold nothing, settlement at the
 * observed cost, release, idempotent closing, atomic concurrent
 * reservations and forgetting an ended turn. Amounts are binary fractions, so a ledger may sum them as
 * plain numbers.
 *
 * @public
 */
export const modelSpendConformance = (subject: ModelSpendSubject): ReadonlyArray<ConformanceCheck> => [
  check("a reservation is held for its turn and in the total", "reserve", (owner) => Effect.scoped(Effect.gen(function* () {
    const ledger = yield* subject.open()
    const runId = RunId.make(`${owner}-turn`)
    const hold = yield* ledger.reserve({ runId, amount: 1.5, caps: { turn: 4, total: 8 } })
    yield* expect("reserve", hold.amount === 1.5 && Option.contains(hold.runId, runId) && hold.id.length > 0, "the hold does not carry the amount and turn asked for")
    const turn = yield* ledger.totals(Option.some(runId))
    const total = yield* ledger.totals(Option.none())
    yield* expect("reserve", totalsAre(turn, 0, 1.5) && totalsAre(total, 0, 1.5), `a held reservation is not counted as reserved (turn: ${shown(turn)}; total: ${shown(total)})`)
  }))),
  check("a reservation past the turn's cap is refused and holds nothing", "turn-cap", (owner) => Effect.scoped(Effect.gen(function* () {
    const ledger = yield* subject.open()
    const runId = RunId.make(`${owner}-turn`)
    const caps: SpendCaps = { turn: 2 }
    yield* ledger.reserve({ runId, amount: 1.5, caps })
    const refused = yield* Effect.result(ledger.reserve({ runId, amount: 1, caps }))
    yield* Result.match(refused, {
      onSuccess: () => expect("turn-cap", false, "a reservation past the turn's cap was held"),
      onFailure: (error) => expect("turn-cap", error._tag === "ModelSpendExceeded" && error.reason === "turn" && error.cap === 2 && error.committed === 1.5 && error.requested === 1,
        `the refusal does not name the turn's cap, what was committed and what was asked for: ${JSON.stringify(error)}`),
    })
    const turn = yield* ledger.totals(Option.some(runId))
    yield* expect("turn-cap", totalsAre(turn, 0, 1.5), `a refused reservation was held (${shown(turn)})`)
    const other = yield* Effect.result(ledger.reserve({ runId: RunId.make(`${owner}-other`), amount: 1.5, caps }))
    yield* expect("turn-cap", Result.isSuccess(other), "another turn's reservation was refused under this turn's cap")
  }))),
  check("a reservation past the total cap is refused across turns and outside them", "total-cap", (owner) => Effect.scoped(Effect.gen(function* () {
    const ledger = yield* subject.open()
    const caps: SpendCaps = { turn: 8, total: 3 }
    yield* ledger.reserve({ runId: RunId.make(`${owner}-a`), amount: 2, caps })
    const refused = yield* Effect.result(ledger.reserve({ runId: RunId.make(`${owner}-b`), amount: 1.5, caps }))
    yield* Result.match(refused, {
      onSuccess: () => expect("total-cap", false, "a reservation past the total cap was held"),
      onFailure: (error) => expect("total-cap", error._tag === "ModelSpendExceeded" && error.reason === "total" && error.cap === 3 && error.committed === 2 && error.requested === 1.5,
        `the refusal does not name the total cap, what was committed and what was asked for: ${JSON.stringify(error)}`),
    })
    const outside = yield* Effect.result(ledger.reserve({ amount: 1.5, caps }))
    yield* expect("total-cap", Result.isFailure(outside), "a reservation outside a turn passed the total cap")
    const total = yield* ledger.totals(Option.none())
    yield* expect("total-cap", totalsAre(total, 0, 2), `a refused reservation was held (${shown(total)})`)
  }))),
  check("settling closes a hold at the observed cost, below or above the amount held", "settle", (owner) => Effect.scoped(Effect.gen(function* () {
    const ledger = yield* subject.open()
    const runId = RunId.make(`${owner}-turn`)
    const caps: SpendCaps = { turn: 4 }
    const first = yield* ledger.reserve({ runId, amount: 2, caps })
    const second = yield* ledger.reserve({ runId, amount: 1, caps })
    yield* ledger.settle(first, 0.5)
    yield* ledger.settle(second, 1.25)
    const turn = yield* ledger.totals(Option.some(runId))
    const total = yield* ledger.totals(Option.none())
    yield* expect("settle", totalsAre(turn, 1.75, 0) && totalsAre(total, 1.75, 0), `settled costs are not what the sends cost (turn: ${shown(turn)}; total: ${shown(total)})`)
    const fits = yield* Effect.result(ledger.reserve({ runId, amount: 2.25, caps }))
    const past = yield* Effect.result(ledger.reserve({ runId, amount: 0.25, caps }))
    yield* expect("settle", Result.isSuccess(fits) && Result.isFailure(past), "settled spend does not count toward the turn's cap")
  }))),
  check("releasing a hold settles nothing and frees its amount", "release", (owner) => Effect.scoped(Effect.gen(function* () {
    const ledger = yield* subject.open()
    const runId = RunId.make(`${owner}-turn`)
    const caps: SpendCaps = { turn: 2, total: 2 }
    const hold = yield* ledger.reserve({ runId, amount: 2, caps })
    yield* ledger.release(hold)
    const turn = yield* ledger.totals(Option.some(runId))
    yield* expect("release", totalsAre(turn, 0, 0), `a released hold is still counted (${shown(turn)})`)
    const again = yield* Effect.result(ledger.reserve({ runId, amount: 2, caps }))
    yield* expect("release", Result.isSuccess(again), "a released hold's amount could not be reserved again")
  }))),
  check("closing a hold again changes nothing", "repeat", (owner) => Effect.scoped(Effect.gen(function* () {
    const ledger = yield* subject.open()
    const runId = RunId.make(`${owner}-turn`)
    const settled = yield* ledger.reserve({ runId, amount: 1, caps: {} })
    const released = yield* ledger.reserve({ runId, amount: 1, caps: {} })
    yield* ledger.settle(settled, 0.5)
    yield* ledger.release(released)
    yield* ledger.settle(settled, 0.5)
    yield* ledger.release(settled)
    yield* ledger.settle(released, 1)
    yield* ledger.release(released)
    const turn = yield* ledger.totals(Option.some(runId))
    const total = yield* ledger.totals(Option.none())
    yield* expect("repeat", totalsAre(turn, 0.5, 0) && totalsAre(total, 0.5, 0), `a closed hold was closed again (turn: ${shown(turn)}; total: ${shown(total)})`)
  }))),
  check("concurrent reservations never take the spend past a cap", "concurrent", (owner) => Effect.scoped(Effect.gen(function* () {
    const ledger = yield* subject.open()
    const runId = RunId.make(`${owner}-turn`)
    const results = yield* Effect.forEach(Array.from({ length: 24 }, (_, index) => index), () =>
      Effect.result(ledger.reserve({ runId, amount: 0.5, caps: { turn: 4, total: 6 } })), { concurrency: "unbounded" })
    const held: ReadonlyArray<SpendHold> = results.flatMap((result) => Result.isSuccess(result) ? [result.success] : [])
    const turn = yield* ledger.totals(Option.some(runId))
    yield* expect("concurrent", held.length === 8 && totalsAre(turn, 0, 4), `${held.length} of 24 concurrent reservations were held under a cap for 8 (${shown(turn)})`)
  }))),
  check("a forgotten turn keeps counting until its holds close, then reads nothing; the total keeps what it settled", "forget", (owner) => Effect.scoped(Effect.gen(function* () {
    const ledger = yield* subject.open()
    const runId = RunId.make(`${owner}-turn`)
    const caps: SpendCaps = { turn: 2 }
    const settled = yield* ledger.reserve({ runId, amount: 1, caps })
    const open = yield* ledger.reserve({ runId, amount: 0.5, caps })
    yield* ledger.settle(settled, 1)
    yield* ledger.forget(runId)
    const ending = yield* ledger.totals(Option.some(runId))
    yield* expect("forget", totalsAre(ending, 1, 0.5), `a forgotten turn with a hold open no longer counts what it settled and holds (${shown(ending)})`)
    const past = yield* Effect.result(ledger.reserve({ runId, amount: 1, caps }))
    yield* expect("forget", Result.isFailure(past), "a forgotten turn with a hold open no longer stays under its cap")
    yield* ledger.settle(open, 0.25)
    const turn = yield* ledger.totals(Option.some(runId))
    const total = yield* ledger.totals(Option.none())
    yield* expect("forget", totalsAre(turn, 0, 0) && totalsAre(total, 1.25, 0), `a forgotten turn whose holds closed still reads its spend, or the total lost it (turn: ${shown(turn)}; total: ${shown(total)})`)
    yield* ledger.forget(RunId.make(`${owner}-unknown`))
    yield* ledger.forget(runId)
  }))),
  check("without caps anything is held, and a reservation outside a turn counts only in the total", "uncapped", (owner) => Effect.scoped(Effect.gen(function* () {
    const ledger = yield* subject.open()
    const runId = RunId.make(`${owner}-turn`)
    yield* ledger.reserve({ runId, amount: 1_000_000, caps: {} })
    const outside = yield* ledger.reserve({ amount: 3, caps: { turn: 1 } })
    yield* ledger.settle(outside, 2)
    const turn = yield* ledger.totals(Option.some(runId))
    const total = yield* ledger.totals(Option.none())
    yield* expect("uncapped", Option.isNone(outside.runId) && totalsAre(turn, 0, 1_000_000) && totalsAre(total, 2, 1_000_000),
      `spend outside a turn or without caps was not counted as asked (turn: ${shown(turn)}; total: ${shown(total)})`)
  }))),
]
