import { describe, expect, test } from "bun:test"
import { payloadText } from "./payload.ts"

describe("payloadText", () => {
  test("pretty-prints, cuts long strings and survives bigint and cycles", () => {
    expect(payloadText({ a: 1, b: "x".repeat(10) }, 4)).toBe('{\n  "a": 1,\n  "b": "xxxx… (6 more characters)"\n}')
    expect(payloadText({ n: 5n })).toContain('"5n"')
    const loop: Record<string, unknown> = {}
    loop.self = loop
    expect(payloadText(loop)).toContain("[circular]")
    expect(payloadText(undefined)).toBe("undefined")
  })
})
