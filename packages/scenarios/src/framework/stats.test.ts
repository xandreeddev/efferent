import { describe, expect, test } from "bun:test"
import { wilsonInterval } from "./stats.js"

describe("binomial uncertainty", () => {
  test("perfect small samples retain visible uncertainty", () => {
    const sound = wilsonInterval(9, 9)
    const unsound = wilsonInterval(15, 15)
    expect(sound.low).toBeCloseTo(0.7008, 3)
    expect(sound.high).toBe(1)
    expect(unsound.low).toBeCloseTo(0.7961, 3)
  })

  test("zero trials means wholly unknown", () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 })
  })
})
