import { describe, expect, test } from "bun:test"
import { bracketMotion } from "./brackets.js"
import type { Key } from "./ParsedKey.js"

const key = (over: Partial<Key>): Key => ({
  name: "",
  ctrl: false,
  shift: false,
  meta: false,
  option: false,
  ...over,
})

describe("bracketMotion", () => {
  test("plain brackets → message step", () => {
    expect(bracketMotion(key({ name: "[" }))).toBe("message-prev")
    expect(bracketMotion(key({ name: "]" }))).toBe("message-next")
  })

  test("explicit braces → paragraph step", () => {
    expect(bracketMotion(key({ name: "{" }))).toBe("paragraph-prev")
    expect(bracketMotion(key({ name: "}" }))).toBe("paragraph-next")
  })

  test("shifted brackets (the US-layout braces) → paragraph step", () => {
    expect(bracketMotion(key({ name: "[", shift: true }))).toBe("paragraph-prev")
    expect(bracketMotion(key({ name: "]", shift: true }))).toBe("paragraph-next")
  })

  test("ctrl/meta brackets and non-brackets → undefined", () => {
    expect(bracketMotion(key({ name: "[", ctrl: true }))).toBeUndefined()
    expect(bracketMotion(key({ name: "]", meta: true }))).toBeUndefined()
    expect(bracketMotion(key({ name: "j" }))).toBeUndefined()
  })
})
