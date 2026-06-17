import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { AgentMessage } from "../entities/Conversation.js"
import { UtilityLlm } from "../ports/UtilityLlm.js"
import { generateSessionTitle, sanitizeTitle } from "./generateTitle.js"

describe("sanitizeTitle", () => {
  test("strips wrapping quotes/backticks, newlines, and a trailing period", () => {
    expect(sanitizeTitle('"Fix The Parser"\n')).toBe("Fix The Parser")
    expect(sanitizeTitle("`tui scroll bug`")).toBe("tui scroll bug")
    expect(sanitizeTitle("“Smart quotes”")).toBe("Smart quotes")
    expect(sanitizeTitle("Refactor session store.")).toBe("Refactor session store")
    expect(sanitizeTitle("multi\nline\ttitle")).toBe("multi line title")
  })

  test("hard-caps the length", () => {
    expect(sanitizeTitle("x".repeat(100)).length).toBe(60)
    expect(sanitizeTitle("x".repeat(100)).endsWith("…")).toBe(true)
  })
})

describe("generateSessionTitle", () => {
  const usage = { inputTokens: 120, outputTokens: 8, totalTokens: 128, cacheReadTokens: 0 }
  const stub = (reply: string, seen?: { prompt?: string }) =>
    Layer.succeed(UtilityLlm, {
      complete: (prompt: string) => {
        if (seen !== undefined) seen.prompt = prompt
        return Effect.succeed({ text: reply, usage })
      },
    })

  const user = (content: string): AgentMessage => ({ role: "user", content })
  const assistant = (text: string): AgentMessage => ({
    role: "assistant",
    content: [{ type: "text", text }],
  })

  test("names the first exchange, sanitizes the reply, reports the spend", async () => {
    const seen: { prompt?: string } = {}
    const res = await Effect.runPromise(
      generateSessionTitle([user("fix the tui scroll bug"), assistant("On it.")]).pipe(
        Effect.provide(stub('"Fix TUI Scroll Bug"\n', seen)),
      ),
    )
    expect(res.title).toBe("Fix TUI Scroll Bug")
    expect(res.usage).toEqual(usage)
    expect(seen.prompt).toContain("USER: fix the tui scroll bug")
    expect(seen.prompt).toContain("ASSISTANT: On it.")
  })

  test("returns an empty title (and no spend) when nothing is nameable", async () => {
    const res = await Effect.runPromise(
      generateSessionTitle([]).pipe(Effect.provide(stub("anything"))),
    )
    expect(res.title).toBe("")
    expect(res.usage).toBeUndefined()
  })
})
