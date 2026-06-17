import { describe, expect, it } from "bun:test"
import { breakdownUsed, categorizeTokens } from "./contextBreakdown.js"
import type { ScrollbackBlock } from "./conversation.js"

const blocks: ReadonlyArray<ScrollbackBlock> = [
  { kind: "user", text: "x".repeat(40) }, // 10 tok
  { kind: "assistant", text: "y".repeat(80) }, // 20 tok
  { kind: "reasoning", text: "z".repeat(40) }, // 10 tok → assistant
  { kind: "tool", id: "t1", toolName: "read foo", state: "ok", output: "o".repeat(160) }, // 2 + 40 = 42 tok
  { kind: "info", text: "ignored chrome" },
  { kind: "error", text: "ignored chrome" },
]

describe("categorizeTokens", () => {
  it("buckets by role (chars/4); reasoning folds into assistant; tool counts output", () => {
    const b = categorizeTokens(blocks, 0)
    expect(b.user).toBe(10)
    expect(b.assistant).toBe(30)
    expect(b.tools).toBe(2 + 40) // "read foo" = 8 chars → 2 tok, output 160 → 40
    expect(breakdownUsed(b)).toBe(10 + 30 + 42)
  })

  it("free = window - used, never negative", () => {
    expect(categorizeTokens(blocks, 1000).free).toBe(1000 - (10 + 30 + 42))
    expect(categorizeTokens(blocks, 10).free).toBe(0)
    expect(categorizeTokens(blocks, 0).free).toBe(0) // unknown window
  })

  it("ignores UI chrome (info/error)", () => {
    const only = categorizeTokens([{ kind: "info", text: "noise" }], 100)
    expect(breakdownUsed(only)).toBe(0)
  })
})
