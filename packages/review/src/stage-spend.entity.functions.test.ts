import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { stageStep } from "./stage-spend.entity.functions.js"

describe("stageStep", () => {
  test("refuse what settled spend leaves no room for, wait when open holds crowd it out, else claim", () => {
    const cases: ReadonlyArray<readonly [{ readonly settled: number; readonly reserved: number }, number, Option.Option<number>, string]> = [
      [{ settled: 0, reserved: 0 }, 1, Option.some(2), "Claim"],
      [{ settled: 0, reserved: 1 }, 1, Option.some(2), "Claim"],
      [{ settled: 0, reserved: 1.5 }, 1, Option.some(2), "Wait"],
      [{ settled: 1.5, reserved: 0 }, 1, Option.some(2), "Refuse"],
      [{ settled: 1.5, reserved: 0.25 }, 1, Option.some(2), "Refuse"],
      [{ settled: 0, reserved: 0 }, 3, Option.some(2), "Refuse"],
      [{ settled: 100, reserved: 100 }, 100, Option.none(), "Claim"],
    ]
    expect<ReadonlyArray<string>>(cases.map(([totals, amount, cap]) => stageStep(totals, amount, cap)._tag)).toEqual(cases.map(([, , , step]) => step))
  })
})
