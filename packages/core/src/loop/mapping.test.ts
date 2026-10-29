import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import type { AgentMessage } from "../domain/message.entity.js"
import { ToolCallId } from "../domain/message.entity.js"
import { uncachedInputTokens } from "../domain/token-usage.entity.functions.js"
import {
  assistantUsage,
  extractUsage,
  responseToAgentMessages,
  responseToolCalls,
  responseToolResults,
  safeKeepFrom,
  toPromptMessages,
  withToolCallIds,
  withUsageOnAssistant,
  extractModel,
} from "./mapping.js"

const assistantMsg: AgentMessage = { role: "assistant", content: [{ type: "text", text: "a" }] }
const toolMsg: AgentMessage = {
  role: "tool",
  content: [{ type: "tool-result", toolCallId: "t" as never, toolName: "x", output: {} }],
}
const userMsg: AgentMessage = { role: "user", content: "u" }

describe("safeKeepFrom", () => {
  test("keeps N assistant turns; the cut always lands ON an assistant message", () => {
    const buffer = [userMsg, assistantMsg, toolMsg, assistantMsg, toolMsg, assistantMsg, toolMsg]
    expect(Option.getOrThrow(safeKeepFrom(buffer, 2))).toBe(3)
    expect(Option.getOrThrow(safeKeepFrom(buffer, 1))).toBe(5)
    expect(buffer[Option.getOrThrow(safeKeepFrom(buffer, 2))]?.role).toBe("assistant")
  })

  test("None when the buffer is too small to fold, or the cut would be index 0", () => {
    expect(Option.isNone(safeKeepFrom([userMsg, assistantMsg, toolMsg], 1))).toBe(true)
    expect(Option.isNone(safeKeepFrom([userMsg, assistantMsg, toolMsg], 5))).toBe(true)
    expect(Option.isNone(safeKeepFrom([assistantMsg, toolMsg, assistantMsg], 2))).toBe(true)
    expect(Option.isNone(safeKeepFrom([], 2))).toBe(true)
  })
})

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
    const usage = extractUsage({ inputTokens: { total: 10 }, outputTokens: { total: 5 } }, [])
    expect(usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    })
  })

  test("Anthropic's shape: the input total holds input_tokens and both cache counts; no reasoning count", () => {
    // What @effect/ai-anthropic reports for input_tokens 3, cache_read_input_tokens 90, cache_creation_input_tokens 7.
    const usage = extractUsage(undefined, [{
      type: "finish", reason: "stop",
      usage: { inputTokens: { uncached: 3, total: 100, cacheRead: 90, cacheWrite: 7 }, outputTokens: { total: 12 } },
    }])
    expect(usage).toEqual({ inputTokens: 100, outputTokens: 12, totalTokens: 112, cacheReadTokens: 90, cacheWriteTokens: 7, reasoningTokens: 0 })
    expect(uncachedInputTokens(usage)).toBe(3)
  })

  test("OpenAI Responses' shape: input_tokens with its cached and written details, output_tokens with its reasoning", () => {
    // What @effect/ai-openai reports for input_tokens 1200 (cached 1000, cache_write 150), output_tokens 300 (reasoning 220).
    const usage = extractUsage({
      inputTokens: { uncached: 200, total: 1200, cacheRead: 1000, cacheWrite: 150 },
      outputTokens: { total: 300, text: 80, reasoning: 220 },
    }, [])
    expect(usage).toEqual({ inputTokens: 1200, outputTokens: 300, totalTokens: 1500, cacheReadTokens: 1000, cacheWriteTokens: 150, reasoningTokens: 220 })
    expect(uncachedInputTokens(usage)).toBe(50)
  })

  test("an output reported below its reasoning is raised to it", () => {
    const usage = extractUsage({ inputTokens: { total: 10 }, outputTokens: { total: 4, reasoning: 9 } }, [])
    expect([usage.outputTokens, usage.reasoningTokens, usage.totalTokens]).toEqual([9, 9, 19])
  })

  test("the finish part's usage fills what the response's usage lacks", () => {
    const usage = extractUsage({ inputTokens: { total: 50 }, outputTokens: { total: 5 } }, [
      { type: "finish", reason: "stop", usage: { inputTokens: { total: 50, cacheRead: 20, cacheWrite: 10 }, outputTokens: { total: 5, reasoning: 2 } } },
    ])
    expect(usage).toEqual({ inputTokens: 50, outputTokens: 5, totalTokens: 55, cacheReadTokens: 20, cacheWriteTokens: 10, reasoningTokens: 2 })
  })

  test("Gemini's raw usage metadata is the last fallback: thoughts are reasoning inside the output", () => {
    const usage = extractUsage(undefined, [{
      type: "finish", reason: "stop", usage: { inputTokens: {}, outputTokens: {} },
      metadata: { google: { usageMetadata: { promptTokenCount: 40, cachedContentTokenCount: 30, candidatesTokenCount: 6, thoughtsTokenCount: 4, totalTokenCount: 50 } } },
    }])
    expect(usage).toEqual({ inputTokens: 40, outputTokens: 10, totalTokens: 50, cacheReadTokens: 30, cacheWriteTokens: 0, reasoningTokens: 4 })
  })

  test("reads the provider's full input and its cache reads, never folding them twice", () => {
    // Effect's Anthropic provider already adds both cache counts to the input total.
    const usage = extractUsage({ inputTokens: { uncached: 3, total: 100, cacheRead: 90, cacheWrite: 7 }, outputTokens: { total: 7 } }, [
      {
        type: "finish",
        reason: "stop",
        usage: { inputTokens: { uncached: 3, total: 100, cacheRead: 90, cacheWrite: 7 }, outputTokens: { total: 7 } },
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
  test("a stamp written before 0.14.0 decodes with 0 cache writes and reasoning; a broken one reads None", () => {
    const stamped = (engine: unknown): AgentMessage => ({ role: "assistant", content: [{ type: "text", text: "hi" }], providerOptions: { engine } })
    const old = stamped({ inputTokens: 100, outputTokens: 7, totalTokens: 107, cacheReadTokens: 90, model: "anthropic:claude" })
    expect(Option.getOrNull(assistantUsage(old))).toEqual({
      inputTokens: 100, outputTokens: 7, totalTokens: 107, cacheReadTokens: 90, cacheWriteTokens: 0, reasoningTokens: 0,
    })
    expect(Option.isNone(assistantUsage(stamped({ inputTokens: "a lot" })))).toBe(true)
  })

  test("embeds and recovers; non-assistant reads None", () => {
    const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
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

  test("toPromptMessages STRIPS the engine stamp outbound; provider blobs survive", () => {
    const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
    const stamped = withUsageOnAssistant(
      [
        {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          // A provider-private blob that MUST keep round-tripping.
          providerOptions: { google: { thought_signature: "sig" } },
        },
      ],
      usage,
    )
    // The stamp landed next to the provider blob…
    expect(
      (stamped[0]?.providerOptions as { engine?: unknown }).engine,
    ).toBeDefined()
    // …but only the provider blob goes back OUT to the wire.
    const encoded = toPromptMessages(stamped) as ReadonlyArray<{
      options?: Record<string, unknown>
    }>
    expect(encoded[0]?.options?.["google"]).toEqual({ thought_signature: "sig" })
    expect(encoded[0]?.options?.["engine"]).toBeUndefined()
    // A stamp-only blob collapses to NO options key at all.
    const stampOnly = withUsageOnAssistant(
      [{ role: "assistant", content: [{ type: "text", text: "hi" }] }],
      usage,
    )
    const bare = toPromptMessages(stampOnly) as ReadonlyArray<{ options?: unknown }>
    expect(bare[0]?.options).toBeUndefined()
    // The persisted message still carries the stamp (recovery on resume).
    expect(Option.getOrNull(assistantUsage(stampOnly[0] as AgentMessage))).toEqual(usage)
  })
})

describe("the model stamp", () => {
  test("extractModel reads the router's finish metadata; the assistant message carries it", () => {
    const content = [
      { type: "text", text: "hi" },
      {
        type: "finish",
        reason: "stop",
        usage: { inputTokens: { total: 5 }, outputTokens: { total: 3 } },
        metadata: { router: { model: "opencode:kimi-k2.7-code" } },
      },
    ]
    const model = extractModel(content)
    expect(Option.getOrThrow(model)).toBe("opencode:kimi-k2.7-code")
    const messages = withUsageOnAssistant(
      [{ role: "assistant", content: [{ type: "text", text: "hi" }] }],
      { inputTokens: 5, outputTokens: 3, totalTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      model,
    )
    const stamped = messages[0]?.providerOptions as { engine?: { model?: string } }
    expect(stamped.engine?.model).toBe("opencode:kimi-k2.7-code")
  })

  test("no stamp → None, and the usage stamp stays model-free", () => {
    expect(Option.isNone(extractModel([{ type: "finish", reason: "stop" }]))).toBe(true)
  })
})

test("tool results persist their schema encoding, not the decoded value", () => {
  const [, tool] = responseToAgentMessages([
    { type: "tool-call", id: "c1", name: "when", params: {} },
    { type: "tool-result", id: "c1", name: "when", result: new Date(0), encodedResult: "1970-01-01T00:00:00.000Z", isFailure: false },
  ])
  expect(tool).toEqual({ role: "tool", content: [{ type: "tool-result", toolCallId: ToolCallId.make("c1"), toolName: "when", output: "1970-01-01T00:00:00.000Z", isError: false }] })
})
