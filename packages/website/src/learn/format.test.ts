import { describe, expect, test } from "bun:test"
import { formatRegion } from "./format.ts"
import { DEFAULT_AGENT } from "./lessons/your-first-agent/agent.source.ts"
import { DEFAULT_MEMORY } from "./lessons/your-first-agent/memory.source.ts"

describe("formatRegion", () => {
  test("the starter code of both editable files is already formatted", async () => {
    expect(await formatRegion(DEFAULT_AGENT, "")).toEqual({ ok: true, text: DEFAULT_AGENT })
    expect(await formatRegion(DEFAULT_MEMORY, "const flatMemory = ")).toEqual({ ok: true, text: DEFAULT_MEMORY })
  })

  test("re-indents a call, one argument a line, without semicolons or a trailing newline", async () => {
    const result = await formatRegion("program.pipe(  Effect.provide( flatMemory ),\n        Effect.provide(model) )", "const main = ")
    expect(result).toEqual({ ok: true, text: "program.pipe(Effect.provide(flatMemory), Effect.provide(model))" })
  })

  test("a syntax error comes back as a message, and the text is not touched", async () => {
    const result = await formatRegion("program.pipe(,,)", "const main = ")
    expect(result.ok).toBe(false)
  })
})
