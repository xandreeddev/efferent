import { expect, test } from "bun:test"
import { heldTo } from "./board.ts"

test("a gate's line says the bounds its finding was held to, and nothing for a finding that does not say", () => {
  expect([
    heldTo({ minimum: 0.8 }),
    heldTo({ maximum: 1 }),
    heldTo({ minimum: 0.5, maximum: 0.875 }),
    heldTo({}),
  ]).toEqual([" at least 0.8", " at most 1", " from 0.5 to 0.88", ""])
})
