import { describe, expect, test } from "bun:test"
import { Option, Result } from "effect"
import { HarnessError } from "../harness/plugin.entity.js"
import { ModelSpendExceeded, ModelSpendUnavailable, SpendHoldId } from "./model-spend.entity.js"
import type { SpendLedger, SpendLimit, SpendRequest } from "./model-spend.entity.js"
import { emptySpendLedger, forgetSpend, modelSpendExceededOf, releaseSpend, reserveSpend, settleSpend, spendTotalsOf } from "./model-spend.entity.functions.js"
import { RunId } from "./run.entity.js"

const a = RunId.make("run-a")
const b = RunId.make("run-b")
type Refusal = readonly [SpendLimit, number, number, number]
const id = (n: number) => SpendHoldId.make(`hold-${n}`)

/** The ledger after holding each request in turn; a refusal fails the test. */
const holding = (requests: ReadonlyArray<SpendRequest>): SpendLedger => requests.reduce((ledger, request, index) =>
  Result.getOrThrow(Result.map(reserveSpend(ledger, request, id(index)), ([, next]) => next)), emptySpendLedger)

describe("reserveSpend", () => {
  test.each([
    { name: "within both caps", before: [], request: { runId: a, amount: 1, caps: { turn: 1, total: 1 } }, refused: Option.none<Refusal>() },
    { name: "past the turn's cap", before: [{ runId: a, amount: 1, caps: {} }], request: { runId: a, amount: 0.5, caps: { turn: 1 } }, refused: Option.some<Refusal>(["turn", 1, 1, 0.5]) },
    { name: "another turn's spend leaves this turn's cap alone", before: [{ runId: b, amount: 1, caps: {} }], request: { runId: a, amount: 1, caps: { turn: 1 } }, refused: Option.none<Refusal>() },
    { name: "past the total, across turns", before: [{ runId: b, amount: 1, caps: {} }], request: { runId: a, amount: 1, caps: { total: 1.5 } }, refused: Option.some<Refusal>(["total", 1.5, 1, 1]) },
    { name: "the turn's cap is checked first", before: [{ runId: a, amount: 1, caps: {} }], request: { runId: a, amount: 1, caps: { turn: 1, total: 1 } }, refused: Option.some<Refusal>(["turn", 1, 1, 1]) },
    { name: "outside a turn, only the total applies", before: [{ runId: a, amount: 1, caps: {} }], request: { amount: 2, caps: { turn: 1, total: 3 } }, refused: Option.none<Refusal>() },
    { name: "an amount above a cap on its own", before: [], request: { runId: a, amount: 2, caps: { turn: 1 } }, refused: Option.some<Refusal>(["turn", 1, 0, 2]) },
  ] satisfies ReadonlyArray<{ readonly name: string; readonly before: ReadonlyArray<SpendRequest>; readonly request: SpendRequest; readonly refused: Option.Option<Refusal> }>)("$name", ({ before, request, refused }) => {
    const ledger = holding(before)
    const decided = reserveSpend(ledger, request, id(99))
    Option.match(refused, {
      onNone: () => {
        const [hold, next] = Result.getOrThrow(decided)
        expect(hold).toEqual({ id: id(99), runId: Option.fromNullishOr(request.runId), amount: request.amount })
        expect(next.holds).toHaveLength(ledger.holds.length + 1)
      },
      onSome: ([reason, cap, committed, requested]) => {
        expect(Result.isFailure(decided)).toBe(true)
        if (Result.isFailure(decided)) expect([decided.failure.reason, decided.failure.cap, decided.failure.committed, decided.failure.requested]).toEqual([reason, cap, committed, requested])
      },
    })
  })
})

describe("settling and releasing", () => {
  const ledger = holding([{ runId: a, amount: 2, caps: {} }, { runId: b, amount: 1, caps: {} }, { amount: 4, caps: {} }])

  test("a hold settles at its cost for its turn and in all; one outside a turn only in all", () => {
    const settled = settleSpend(settleSpend(ledger, id(0), 0.5), id(2), 3)
    expect(spendTotalsOf(settled, Option.some(a))).toEqual({ settled: 0.5, reserved: 0 })
    expect(spendTotalsOf(settled, Option.some(b))).toEqual({ settled: 0, reserved: 1 })
    expect(spendTotalsOf(settled, Option.none())).toEqual({ settled: 3.5, reserved: 1 })
  })

  test("a release settles nothing; closing an unknown or closed hold changes nothing", () => {
    const released = releaseSpend(ledger, id(1))
    expect(spendTotalsOf(released, Option.some(b))).toEqual({ settled: 0, reserved: 0 })
    expect(settleSpend(released, id(1), 5)).toBe(released)
    expect(releaseSpend(released, id(1))).toBe(released)
    expect(settleSpend(ledger, id(42), 1)).toBe(ledger)
  })
})

describe("forgetSpend", () => {
  const ledger = holding([{ runId: a, amount: 2, caps: {} }, { runId: a, amount: 1, caps: {} }, { runId: b, amount: 1, caps: {} }])

  test("an ended turn with nothing open loses its entry at once; the total keeps what it settled", () => {
    const forgotten = forgetSpend(settleSpend(settleSpend(ledger, id(0), 1.5), id(1), 0.5), a)
    expect(spendTotalsOf(forgotten, Option.some(a))).toEqual({ settled: 0, reserved: 0 })
    expect(spendTotalsOf(forgotten, Option.none())).toEqual({ settled: 2, reserved: 1 })
    expect(Object.keys(forgotten.settledByRun)).toEqual([])
    expect(forgotten.ending).toEqual([])
  })

  test("an ended turn with a hold open keeps counting until its last hold closes", () => {
    const forgotten = forgetSpend(settleSpend(ledger, id(0), 1.5), a)
    expect(spendTotalsOf(forgotten, Option.some(a))).toEqual({ settled: 1.5, reserved: 1 })
    expect(forgotten.ending).toEqual([a])
    expect(forgetSpend(forgotten, a)).toBe(forgotten)
    const closed = releaseSpend(forgotten, id(1))
    expect(spendTotalsOf(closed, Option.some(a))).toEqual({ settled: 0, reserved: 0 })
    expect(spendTotalsOf(closed, Option.none())).toEqual({ settled: 1.5, reserved: 1 })
    expect(closed.ending).toEqual([])
    expect(Object.keys(closed.settledByRun)).toEqual([])
  })

  test("forgetting a turn the ledger has nothing for keeps nothing of it", () => {
    expect(forgetSpend(ledger, RunId.make("run-unknown"))).toEqual(ledger)
  })
})

describe("modelSpendExceededOf", () => {
  const exceeded = new ModelSpendExceeded({ reason: "turn", cap: 1, committed: 1, requested: 0.5, message: "past the cap" })

  test("finds the refusal itself, or as the cause of the turn's failure", () => {
    expect(Option.map(modelSpendExceededOf(exceeded), (found) => found.reason)).toEqual(Option.some("turn"))
    expect(Option.map(modelSpendExceededOf(new HarnessError({ code: "model.spend", message: "refused", cause: exceeded })), (found) => found.cap)).toEqual(Option.some(1))
  })

  test("finds nothing in another failure", () => {
    expect(modelSpendExceededOf(new ModelSpendUnavailable({ message: "down" }))).toEqual(Option.none())
    expect(modelSpendExceededOf(new HarnessError({ code: "model.spend", message: "down", cause: new ModelSpendUnavailable({ message: "down" }) }))).toEqual(Option.none())
    expect(modelSpendExceededOf("past the cap")).toEqual(Option.none())
  })
})
