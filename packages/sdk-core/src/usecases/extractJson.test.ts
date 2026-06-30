import { describe, expect, it } from "bun:test"
import { extractJsonObjects } from "./extractJson.js"

describe("extractJsonObjects", () => {
  it("returns the single object in clean JSON", () => {
    expect(extractJsonObjects('{"a":1}')).toEqual(['{"a":1}'])
  })

  it("returns objects LAST-FIRST (the trailing verdict wins)", () => {
    expect(extractJsonObjects('{"first":1} then {"last":2}')).toEqual(['{"last":2}', '{"first":1}'])
  })

  it("ignores braces inside string VALUES (string-aware scan)", () => {
    // The `}` inside the string must not close the object early.
    expect(extractJsonObjects('{"msg":"a } b { c"}')).toEqual(['{"msg":"a } b { c"}'])
  })

  it("handles escaped quotes inside strings", () => {
    expect(extractJsonObjects('{"msg":"say \\"hi\\" }"}')).toEqual(['{"msg":"say \\"hi\\" }"}'])
  })

  it("finds the verdict object AFTER brace-heavy prose (the greedy-regex failure)", () => {
    const text =
      "The handler `const f = () => { return { x: 1 } }` is off, and `{ ok: false }` too.\n" +
      '```json\n{"verdict":"needs_work","reasons":["fix it"]}\n```'
    // The trailing verdict object is first in the last-first result.
    expect(extractJsonObjects(text)[0]).toBe('{"verdict":"needs_work","reasons":["fix it"]}')
  })

  it("captures nested objects as one top-level object (not split)", () => {
    expect(extractJsonObjects('{"v":"sound","meta":{"n":1}}')).toEqual(['{"v":"sound","meta":{"n":1}}'])
  })

  it("returns [] when there is no object", () => {
    expect(extractJsonObjects("no json here")).toEqual([])
    expect(extractJsonObjects("")).toEqual([])
  })

  it("ignores an unterminated object", () => {
    expect(extractJsonObjects('{"a":1')).toEqual([])
  })
})
