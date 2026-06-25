import { describe, expect, test } from "bun:test"
import { renderScopeSystemPrompt } from "./scopeAgent.js"
import { coordinationSection } from "./sections.js"

describe("coordinationSection — fleet-awareness nudge (FIX 2 fallback)", () => {
  // A freshly-spawned sub-agent starts with only its task in context (the plan
  // isn't cleanly reachable at spawn time — see the report). The cache-safe
  // substitute is a STATIC prompt nudge telling workers to read the blackboard
  // first, so they pick up siblings' findings instead of working blind.
  test("tells workers to read the blackboard first", () => {
    expect(coordinationSection).toContain("Read the blackboard FIRST")
    expect(coordinationSection).toContain("blackboard_read")
  })

  test("the nudge is injected into every spawned sub-agent's system prompt", () => {
    const prompt = renderScopeSystemPrompt({
      name: "worker",
      rootDir: "/tmp/ws/pkg",
      displayRoot: "/tmp/ws",
      body: "do the thing",
      now: new Date("2026-06-20T00:00:00Z"),
    })
    expect(prompt).toContain("Read the blackboard FIRST")
  })

  test("the nudge is STATIC — no timestamp / mutable state baked in (cache-safe prefix)", () => {
    // Rendering at two different wall-clock instants must not change the
    // coordination nudge (a moving prefix would break each agent's prompt cache).
    const a = renderScopeSystemPrompt({
      name: "w",
      rootDir: "/tmp/ws/pkg",
      displayRoot: "/tmp/ws",
      body: "b",
      now: new Date("2026-06-20T00:00:00Z"),
    })
    const b = renderScopeSystemPrompt({
      name: "w",
      rootDir: "/tmp/ws/pkg",
      displayRoot: "/tmp/ws",
      body: "b",
      now: new Date("2026-06-20T12:34:56Z"),
    })
    // The only difference between the two is the dated header line; the
    // coordination nudge text is identical in both.
    expect(a.includes(coordinationSection)).toBe(true)
    expect(b.includes(coordinationSection)).toBe(true)
  })
})
