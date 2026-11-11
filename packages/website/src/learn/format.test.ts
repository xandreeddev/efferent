import { describe, expect, test } from "bun:test"
import { formatRegion } from "./format.ts"
import { DEFAULT_TINY } from "./tiny-memory.source.ts"

describe("formatRegion", () => {
  test("the starter tiny-memory code is already formatted", async () => {
    expect(await formatRegion(DEFAULT_TINY, "const tinyMemory = ")).toEqual({ ok: true, text: DEFAULT_TINY })
  })

  test("re-indents and breaks an object, without semicolons or a trailing newline", async () => {
    const result = await formatRegion("{ system: 'hi',\n   limits: { maxSteps: 3 },\n        plugins: [a, b] }", "const config = ")
    expect(result).toEqual({ ok: true, text: '{ system: "hi", limits: { maxSteps: 3 }, plugins: [a, b] }' })
  })

  test("a syntax error comes back as a message, and the text is not touched", async () => {
    const result = await formatRegion("{ a: 1,, }", "const config = ")
    expect(result.ok).toBe(false)
  })
})
