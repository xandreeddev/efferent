import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { CheckConfig } from "./Rules.js"

describe("standing command configuration", () => {
  test("legacy checks decode at the test rank with the standard timeout", () => {
    const decoded = Schema.decodeUnknownSync(CheckConfig)({ name: "tests", command: "bun test" })
    expect(decoded.kind).toBe("test")
    expect(decoded.timeoutMs).toBe(300_000)
  })

  test("eval checks preserve their later cost rank and explicit timeout", () => {
    const decoded = Schema.decodeUnknownSync(CheckConfig)({
      name: "scenarios",
      command: "bun run scenarios",
      kind: "eval",
      timeoutMs: 900_000,
    })
    expect(decoded.kind).toBe("eval")
    expect(decoded.timeoutMs).toBe(900_000)
  })
})
