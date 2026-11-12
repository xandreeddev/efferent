import { describe, expect, test } from "bun:test"
import { formatRegion } from "./format.ts"
import { DEFAULT_AGENT } from "./lesson1.source.ts"
import { DEFAULT_TINY } from "./tiny-memory.source.ts"

describe("formatRegion", () => {
  test("the starter code of both files is already formatted", async () => {
    expect(await formatRegion(DEFAULT_AGENT, "const Agent = ")).toEqual({ ok: true, text: DEFAULT_AGENT })
    expect(await formatRegion(DEFAULT_TINY, "const lastMessages = ")).toEqual({ ok: true, text: DEFAULT_TINY })
  })

  test("re-indents a call, one argument a line, without semicolons or a trailing newline", async () => {
    const result = await formatRegion("inbox.pipe(  Layer.provideMerge( stepLoop ),\n        Layer.provideMerge(settings({ system: 'hi' })) )", "const Agent = ")
    expect(result).toEqual({ ok: true, text: 'inbox.pipe(\n  Layer.provideMerge(stepLoop),\n  Layer.provideMerge(settings({ system: "hi" })),\n)' })
  })

  test("a syntax error comes back as a message, and the text is not touched", async () => {
    const result = await formatRegion("inbox.pipe(,,)", "const Agent = ")
    expect(result.ok).toBe(false)
  })
})
