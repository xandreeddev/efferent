import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { DEFAULT_AGENT } from "./lesson1.source.ts"
import { readControls, setField, withoutMemory } from "./config-edit.ts"

const set = (source: string, key: Parameters<typeof setField>[1], value: string | number) => Option.getOrThrow(setField(source, key, value))

describe("agent controls", () => {
  test("reads what the starter says", () => {
    expect(readControls(DEFAULT_AGENT)).toEqual({ system: "You are a friendly tutor. Keep answers short.", budgetTokens: 3000, memory: "window" })
  })

  test("each setter rewrites only its line", () => {
    const edited = set(set(DEFAULT_AGENT, "budgetTokens", 2000), "system", 'Talk like a "pirate".\nArr.')
    expect(readControls(edited)).toEqual({ system: 'Talk like a "pirate".\nArr.', budgetTokens: 2000, memory: "window" })
    expect(edited).toContain("Layer.provideMerge(stepLoop)")
  })

  test("the memory picker swaps the memory line and keeps the budget", () => {
    const last = set(set(DEFAULT_AGENT, "budgetTokens", 1200), "memory", "last")
    expect(last).toContain("Layer.provideMerge(lastMessages({ n: 1, budgetTokens: 1200 }))")
    expect(readControls(last)).toMatchObject({ memory: "last", budgetTokens: 1200 })
    expect(set(last, "memory", "window")).toBe(set(DEFAULT_AGENT, "budgetTokens", 1200))
  })

  test("removing the memory line leaves the rest of the stack", () => {
    const removed = Option.getOrThrow(withoutMemory(DEFAULT_AGENT))
    expect(removed).not.toContain("Memory")
    expect(removed).toContain("Layer.provideMerge(stepLoop),\n  Layer.provideMerge(settings(")
    expect(readControls(removed).memory).toBeUndefined()
  })

  test("a line the learner removed is reported, not invented", () => {
    expect(Option.isNone(setField("inbox", "budgetTokens", 3))).toBe(true)
    expect(Option.isNone(setField("inbox", "memory", "last"))).toBe(true)
    expect(Option.isNone(withoutMemory("inbox"))).toBe(true)
  })
})
