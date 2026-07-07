import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import type { AgentMessage } from "../domain/Message.js"
import {
  assistantUsage,
  extractUsage,
  responseToAgentMessages,
  responseToolCalls,
  responseToolResults,
  toPromptMessages,
  withToolCallIds,
  withUsageOnAssistant,
} from "./mapping.js"

describe("withToolCallIds", () => {
  test("mints deterministic ids for id-less calls/results; keeps provider ids", () => {
    const content = [
      { type: "tool-call", name: "read", params: { path: "a" } },
      { type: "tool-call", id: "prov_1", name: "grep", params: {} },
      { type: "tool-call", name: "read", params: { path: "b" } },
      { type: "tool-result", name: "read", result: { ok: 1 } },
      { type: "tool-result", id: "prov_1", name: "grep", result: {} },
      { type: "tool-result", name: "read", result: { ok: 2 } },
    ]
    const out = withToolCallIds(content, 7) as ReadonlyArray<{ id?: string }>
    expect(out.map((p) => p.id)).toEqual([
      "7:read:0",
      "prov_1",
      "7:read:2",
      "7:read:0",
      "prov_1",
      "7:read:2",
    ])
    // Pure: the input parts were not mutated.
    expect((content[0] as { id?: string }).id).toBeUndefined()
  })

  test("the Nth id-less call and Nth id-less result pair on the same ordinal", () => {
    const out = withToolCallIds(
      [
        { type: "tool-call", name: "a", params: {} },
        { type: "tool-result", name: "a", result: {} },
      ],
      0,
    )
    const calls = responseToolCalls(out)
    const results = responseToolResults(out)
    expect(calls[0]?.id).toBe(results[0]?.id)
  })
})

describe("responseToAgentMessages ↔ toPromptMessages", () => {
  test("provider metadata round-trips as providerOptions (the thought_signature path)", () => {
    const content = [
      { type: "reasoning", text: "hmm", metadata: { google: { thoughtSignature: "sig" } } },
      { type: "text", text: "done" },
      { type: "tool-call", id: "c1", name: "read", params: { path: "x" } },
      { type: "tool-result", id: "c1", name: "read", result: { text: "hi" } },
    ]
    const messages = responseToAgentMessages(content)
    expect(messages).toHaveLength(2)
    const encoded = toPromptMessages(messages) as ReadonlyArray<{
      role: string
      content: ReadonlyArray<{ type: string; options?: unknown }>
    }>
    const reasoning = encoded[0]?.content.find((p) => p.type === "reasoning")
    expect(reasoning?.options).toEqual({ google: { thoughtSignature: "sig" } })
    const result = encoded[1]?.content[0] as { result?: unknown }
    expect(result?.result).toEqual({ text: "hi" })
  })
})

describe("extractUsage", () => {
  test("reads plain usage", () => {
    const usage = extractUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }, [])
    expect(usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cacheReadTokens: 0,
    })
  })

  test("folds Anthropic cache reads/writes back into input", () => {
    const usage = extractUsage({ inputTokens: 3, outputTokens: 7, totalTokens: 10 }, [
      {
        type: "finish",
        reason: "stop",
        usage: { inputTokens: 3, outputTokens: 7 },
        metadata: {
          anthropic: {
            usage: { cache_read_input_tokens: 90, cache_creation_input_tokens: 7 },
          },
        },
      },
    ])
    expect(usage.inputTokens).toBe(100)
    expect(usage.cacheReadTokens).toBe(90)
    expect(usage.totalTokens).toBe(107)
  })
})

describe("withUsageOnAssistant / assistantUsage", () => {
  test("embeds and recovers; non-assistant reads None", () => {
    const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3, cacheReadTokens: 0 }
    const tail: ReadonlyArray<AgentMessage> = [
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "tool", content: [] },
    ]
    const out = withUsageOnAssistant(tail, usage)
    const recovered = assistantUsage(out[0] as AgentMessage)
    expect(Option.getOrNull(recovered)).toEqual(usage)
    expect(Option.isNone(assistantUsage(out[1] as AgentMessage))).toBe(true)
    // Pure: the original message is untouched.
    expect((tail[0] as { providerOptions?: unknown }).providerOptions).toBeUndefined()
  })
})
