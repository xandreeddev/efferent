import { expect, test } from "bun:test"
import { Option } from "effect"
import { SpendHoldId } from "@xandreed/core"
import type { SpendRequest } from "@xandreed/core"
import { budgetStopOf, cappedAtBudget, held, refusalOf, refused, released, reserving, runSpendOf, settled, trialSpendOf, unmetered } from "./spend.entity.functions.js"

const first = SpendHoldId.make("first")
const second = SpendHoldId.make("second")

test("a run's budget caps a reservation's total at the lower of the two, and leaves its other caps", () => {
  const request: SpendRequest = { amount: 1, caps: { turn: 3 } }
  expect(cappedAtBudget(request, Option.none())).toEqual(request)
  expect(cappedAtBudget(request, Option.some(5))).toEqual({ amount: 1, caps: { turn: 3, total: 5 } })
  expect(cappedAtBudget({ amount: 1, caps: { total: 2 } }, Option.some(5)).caps).toEqual({ total: 2 })
  expect(cappedAtBudget({ amount: 1, caps: { total: 8 } }, Option.some(5)).caps).toEqual({ total: 5 })
})

test("a trial's account is unmetered until it reserves, then counts what its own open holds settle, once each", () => {
  expect(trialSpendOf(unmetered)).toEqual(Option.none())
  expect(trialSpendOf(reserving(unmetered))).toEqual(Option.some({ settled: 0 }))
  const open = held(held(reserving(unmetered), first), second)
  const closed = released(settled(open, first, 0.5), second)
  expect(trialSpendOf(closed)).toEqual(Option.some({ settled: 0.5 }))
  // A hold closed already, or one the account never held, changes nothing.
  expect(settled(closed, first, 0.5)).toEqual(closed)
  expect(settled(closed, SpendHoldId.make("another"), 1)).toEqual(closed)
  expect(settled(released(open, first), first, 1)).toEqual(released(open, first))
  expect(settled(unmetered, first, 1)).toEqual(unmetered)
})

test("an account keeps the first refusal under the total cap", () => {
  expect(refusalOf(unmetered)).toEqual(Option.none())
  const once = refused(unmetered, "the first")
  expect(refusalOf(refused(once, "the second"))).toEqual(Option.some("the first"))
  expect(trialSpendOf(once)).toEqual(Option.some({ settled: 0 }))
})

test("a run stops at a refusal under its total cap, or once what it settled reaches its budget", () => {
  const totals = (value: number) => ({ settled: value, reserved: 0 })
  expect(budgetStopOf(Option.none(), Option.none(), totals(100))).toEqual(Option.none())
  expect(budgetStopOf(Option.none(), Option.some(2), totals(1.5))).toEqual(Option.none())
  expect(budgetStopOf(Option.none(), Option.some(2), totals(2))).toEqual(Option.some("the run's spend budget of 2 is reached: 2 is settled"))
  expect(budgetStopOf(Option.some("refused"), Option.some(2), totals(0))).toEqual(Option.some("refused"))
  expect(budgetStopOf(Option.some("refused"), Option.none(), totals(0))).toEqual(Option.some("refused"))
})

test("a run records its spend when it had a budget or a trial reserved, and none when nothing was metered", () => {
  const totals = { settled: 1.25, reserved: 0 }
  expect(runSpendOf(Option.none(), totals, [{}, {}])).toEqual(Option.none())
  expect(runSpendOf(Option.some(3), totals, [{}])).toEqual(Option.some({ budget: Option.some(3), settled: 1.25 }))
  expect(runSpendOf(Option.none(), totals, [{}, { spend: { settled: 1.25 } }])).toEqual(Option.some({ budget: Option.none(), settled: 1.25 }))
})
