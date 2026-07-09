import { expect, test } from "bun:test"
import { formatDate } from "./format.js"

test("pads month and day", () => {
  expect(formatDate(new Date(2026, 0, 5))).toBe("2026-01-05")
})
