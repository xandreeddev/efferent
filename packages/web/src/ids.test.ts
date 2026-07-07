import { describe, expect, test } from "bun:test"
import { domIdForKey } from "./ids.js"

const CSS_SAFE_ID = /^[A-Za-z][A-Za-z0-9_-]*$/

describe("domIdForKey", () => {
  test("encodes the TUI message-key shape", () => {
    expect(domIdForKey("blk", "m:p3:a0")).toBe("blk-m_3Ap3_3Aa0")
  })

  test("escapes literal underscores so hex codes can't be forged", () => {
    // "_3A" as LITERAL characters must not decode like an encoded ":".
    expect(domIdForKey("blk", "_3A")).toBe("blk-__3A")
    expect(domIdForKey("blk", ":")).toBe("blk-_3A")
    expect(domIdForKey("blk", "_3A")).not.toBe(domIdForKey("blk", ":"))
  })

  test("is injective across adversarial near-collisions", () => {
    const keys = [
      "m:p3:a0",
      "m_p3_a0",
      "m:p3:a1",
      "m::p3",
      ":",
      "::",
      "_",
      "__",
      "_3A",
      ":_",
      "_:",
      "a b",
      "a%20b",
      "path/to/file.ts",
      "path_to_file.ts",
      "0:read_file:1",
      "0_read_file_1",
      "ünïcode✓",
      "",
    ]
    const encoded = keys.map((k) => domIdForKey("blk", k))
    expect(new Set(encoded).size).toBe(keys.length)
  })

  test("outputs are CSS-selector-safe (no colons, quotes or spaces)", () => {
    const nasty = [`a"b`, "a'b", "a b", "a:b", "a.b", "a#b", "a[b]", "é✓\n\t"]
    for (const k of nasty) {
      const id = domIdForKey("ui", k)
      expect(id).toMatch(CSS_SAFE_ID)
    }
  })

  test("prefixes separate families with identical keys", () => {
    expect(domIdForKey("blk", "x")).not.toBe(domIdForKey("ui", "x"))
  })
})
