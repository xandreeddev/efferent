import { describe, expect, test } from "bun:test"
import { llmSpanName, runSpanName, subagentSpanName, toolSpanName, turnSpanName } from "./spanNames.js"

describe("runSpanName", () => {
  test("keeps the root run name stable", () => {
    expect(runSpanName()).toBe("agent.run")
  })
})

describe("turnSpanName", () => {
  test("includes the turn index", () => {
    expect(turnSpanName(0)).toBe("agent.turn 0")
    expect(turnSpanName(7)).toBe("agent.turn 7")
  })
})

describe("toolSpanName", () => {
  test("uses the agent.tool namespace", () => {
    expect(toolSpanName("read_file")).toBe("agent.tool.read_file")
    expect(toolSpanName("Bash")).toBe("agent.tool.Bash")
  })
})

describe("llmSpanName", () => {
  test("uses prompt label + provider/model when prompt is present", () => {
    expect(
      llmSpanName({ name: "coder", version: "1.2.0", text: "" }, "main", "openai", "gpt-4.1"),
    ).toBe("llm.generate coder@1.2.0 · openai/gpt-4.1")
  })

  test("includes variant in prompt label", () => {
    expect(
      llmSpanName(
        { name: "coder", version: "1.2.0", variant: "terse", text: "" },
        "main",
        "anthropic",
        "claude-sonnet-4",
      ),
    ).toBe("llm.generate coder:terse@1.2.0 · anthropic/claude-sonnet-4")
  })

  test("falls back to role when no prompt identity is in context", () => {
    expect(llmSpanName(undefined, "fast", "google", "gemini-flash")).toBe(
      "llm.generate fast · google/gemini-flash",
    )
  })
})

describe("subagentSpanName", () => {
  test("includes label, folder basename, and depth", () => {
    expect(subagentSpanName("refactor plan", "/ws/packages/core", 1)).toBe(
      "agent.subagent refactor plan · core · d1",
    )
  })

  test("sanitizes a long label", () => {
    const long = "a".repeat(100)
    expect(subagentSpanName(long, "/ws/core", 2)).toBe(
      `agent.subagent ${"a".repeat(49)}… · core · d2`,
    )
  })
})
