import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import type { AgentMessage } from "../domain/message.entity.js"
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

  test("toPromptMessages STRIPS the engine stamp outbound; provider blobs survive", () => {
    const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3, cacheReadTokens: 0 }
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
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
        metadata: { router: { model: "opencode:kimi-k2.7-code" } },
      },
    ]
    const model = extractModel(content)
    expect(Option.getOrThrow(model)).toBe("opencode:kimi-k2.7-code")
    const messages = withUsageOnAssistant(
      [{ role: "assistant", content: [{ type: "text", text: "hi" }] }],
      { inputTokens: 5, outputTokens: 3, totalTokens: 8, cacheReadTokens: 0 },
      model,
    )
    const stamped = messages[0]?.providerOptions as { engine?: { model?: string } }
    expect(stamped.engine?.model).toBe("opencode:kimi-k2.7-code")
  })

  test("no stamp → None, and the usage stamp stays model-free", () => {
    expect(Option.isNone(extractModel([{ type: "finish", reason: "stop" }]))).toBe(true)
  })
})
