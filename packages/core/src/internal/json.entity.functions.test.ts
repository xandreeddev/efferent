import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { asJsonRecord } from "./json.entity.functions.js"

describe("asJsonRecord", () => {
  test("a parsed JSON object reads as itself", () => {
    expect(asJsonRecord(Option.some({ a: 1, nested: { list: [true, null] } }))).toEqual({ a: 1, nested: { list: [true, null] } })
  })

  test("an array, a scalar, a value JSON cannot hold or nothing reads as {}", () => {
    expect([[1, 2], "text", 3, null, { big: 1n }].map((value) => asJsonRecord(Option.some(value)))).toEqual([{}, {}, {}, {}, {}])
    expect(asJsonRecord(Option.none())).toEqual({})
  })
})
