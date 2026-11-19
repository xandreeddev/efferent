import { describe, expect, test } from "bun:test"
import { Prompt } from "effect/ai"
import { answerContentOf, sentContentOf } from "./content.entity.functions.js"

describe("a model call's content, as OpenTelemetry's generative AI conventions write it", () => {
  test("a prompt: the system text apart; each message with its parts; a file named by its type alone", () => {
    const prompt = Prompt.make([
      { role: "system", content: "Be brief." },
      { role: "user", content: [{ type: "text", text: "Read this." }, { type: "file", mediaType: "image/png", data: new Uint8Array([1, 2, 3]) }] },
      { role: "assistant", content: [{ type: "reasoning", text: "A picture." }, { type: "tool-call", id: "c1", name: "look", params: { at: "it" }, providerExecuted: false }] },
      { role: "tool", content: [{ type: "tool-result", id: "c1", name: "look", isFailure: true, result: "too dark", providerExecuted: false }] },
    ])
    expect(sentContentOf(prompt)).toEqual({
      system: [{ type: "text", content: "Be brief." }],
      messages: [
        { role: "user", parts: [{ type: "text", content: "Read this." }, { type: "file", mime_type: "image/png" }] },
        { role: "assistant", parts: [{ type: "reasoning", content: "A picture." }, { type: "tool_call", id: "c1", name: "look", arguments: { at: "it" } }] },
        { role: "tool", parts: [{ type: "tool_call_response", id: "c1", response: "too dark", is_failure: true }] },
      ],
    })
  })

  test("a streamed answer: its pieces joined in the order they came, its calls, why it stopped", () => {
    const usage = { inputTokens: { total: 1, uncached: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }
    const parts = [
      { type: "reasoning-delta", id: "r", delta: "Think" },
      { type: "reasoning-delta", id: "r", delta: "ing." },
      { type: "text-delta", id: "t", delta: "It is " },
      { type: "text-delta", id: "t", delta: "5." },
      { type: "tool-call", id: "c2", name: "add", params: { a: 2, b: 3 }, providerExecuted: false },
      { type: "finish", reason: "tool-calls", usage },
    ] as const
    expect(answerContentOf(parts as never)).toEqual([{
      role: "assistant",
      parts: [{ type: "reasoning", content: "Thinking." }, { type: "text", content: "It is 5." }, { type: "tool_call", id: "c2", name: "add", arguments: { a: 2, b: 3 } }],
      finish_reason: "tool-calls",
    }])
  })
})
