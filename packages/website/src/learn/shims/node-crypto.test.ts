import { createHash as nodeHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { createHash } from "./node-crypto.ts"

describe("browser sha256 shim", () => {
  test("matches node:crypto on edge lengths and unicode", () => {
    const inputs = ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "a".repeat(1000), "héllo ✓ 世界", JSON.stringify({ k: [1, 2, 3] })]
    for (const input of inputs) {
      expect(createHash("sha256").update(input).digest("hex")).toBe(nodeHash("sha256").update(input).digest("hex"))
    }
  })
})
