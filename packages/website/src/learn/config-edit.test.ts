import { describe, expect, test } from "bun:test"
import { DEFAULT_CONFIG } from "./lesson1.source.ts"
import { readControls, setField } from "./config-edit.ts"

describe("config controls", () => {
  test("reads what the starter says", () => {
    expect(readControls(DEFAULT_CONFIG)).toEqual({
      system: "You are a friendly tutor. Keep answers short.", maxSteps: 10, streaming: true, budgetTokens: 3000,
    })
  })

  test("each setter rewrites only its field", () => {
    const edited = setField(setField(setField(setField(DEFAULT_CONFIG, "maxSteps", 3)!, "streaming", false)!, "budgetTokens", 2000)!, "system", 'Talk like a "pirate".\nArr.')!
    expect(readControls(edited)).toEqual({ system: 'Talk like a "pirate".\nArr.', maxSteps: 3, streaming: false, budgetTokens: 2000 })
    expect(edited.replace(/system: ".*",\n/, "").length).toBeLessThan(DEFAULT_CONFIG.length + 40)
    expect(edited).toContain("memoryWindowPlugin")
  })

  test("a field the learner removed is reported, not invented", () => {
    expect(setField("{ plugins: [] }", "maxSteps", 3)).toBeUndefined()
  })
})
