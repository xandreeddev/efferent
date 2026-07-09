import { expect, test } from "bun:test"
import { mean, median } from "./stats.js"

test("stats of [1,2,3]", () => {
  expect(mean([1, 2, 3])).toBe(2)
  expect(median([1, 2, 3])).toBe(2)
})
