import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { stageStep } from "./stage-spend.entity.functions.js"

describe("stageStep", () => {
  test("refuse what settled spend leaves no room for, wait when open calls crowd it out, refuse when only what is kept back does, else claim", () => {
    const cases: ReadonlyArray<readonly [{ readonly settled: number; readonly reserved: number; readonly open: number }, number, Option.Option<number>, string]> = [
      [{ settled: 0, reserved: 0, open: 0 }, 1, Option.some(2), "Claim"],
      [{ settled: 0, reserved: 1, open: 1 }, 1, Option.some(2), "Claim"],
      [{ settled: 0, reserved: 1.5, open: 1 }, 1, Option.some(2), "Wait"],
      [{ settled: 1.5, reserved: 0, open: 0 }, 1, Option.some(2), "Refuse"],
      [{ settled: 1.5, reserved: 0.25, open: 1 }, 1, Option.some(2), "Refuse"],
      [{ settled: 0, reserved: 0, open: 0 }, 3, Option.some(2), "Refuse"],
      // What is kept back crowds it out and no call is open to close: refused, never left waiting.
      [{ settled: 0, reserved: 0.1, open: 0 }, 0.25, Option.some(0.31), "Refuse"],
      [{ settled: 0, reserved: 0.1, open: 0 }, 0.2, Option.some(0.31), "Claim"],
      [{ settled: 100, reserved: 100, open: 3 }, 100, Option.none(), "Claim"],
    ]
    expect<ReadonlyArray<string>>(cases.map(([totals, amount, cap]) => stageStep(totals, amount, cap)._tag)).toEqual(cases.map(([, , , step]) => step))
  })
})
