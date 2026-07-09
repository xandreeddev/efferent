import { expect, test } from "bun:test"
import { withRetry } from "./retry.js"

test("resolves a succeeding fn", async () => {
  expect(await withRetry(async () => 42, 3)).toBe(42)
})
