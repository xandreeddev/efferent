import { describe, expect, it } from "bun:test"
import { Arbitrary, FastCheck as fc } from "effect"
import { AgentMessage } from "../entities/Conversation.js"
import type { TokenUsage } from "../ports/LlmInfo.js"
import {
  assistantUsage,
  attachUsageToAssistant,
  ensureToolCallIds,
  extractUsage,
  handoffToMessage,
  recoverConversationStats,
  responseReasoning,
  responseText,
  responseToAgentMessages,
  responseToolCalls,
  responseToolResults,
  toPromptMessages,
} from "./promptMapping.js"

const msgArrayArb = fc.array(Arbitrary.make(AgentMessage), { maxLength: 8 })

const usageArb: fc.Arbitrary<TokenUsage> = fc.record({
  inputTokens: fc.nat(),
  outputTokens: fc.nat(),
  totalTokens: fc.nat(),
  cacheReadTokens: fc.nat(),
})

/** Mirror of promptMapping's `hasKeys` — the options-presence predicate. */
const hasKeys = (o: unknown): boolean =>
  typeof o === "object" && o !== null && Object.keys(o).length > 0

// ─── toPromptMessages ────────────────────────────────────────────────────────

describe("properties — toPromptMessages", () => {
  it("is total and maps every message 1:1, preserving roles, parts, and options presence", () => {
    fc.assert(
      fc.property(msgArrayArb, (messages) => {
        const out = toPromptMessages(messages) as Array<{
          role: string
          content: unknown
          options?: unknown
        }>
        expect(out.length).toBe(messages.length)
        for (let i = 0; i < messages.length; i++) {
          const src = messages[i]!
          const dst = out[i]!
          expect(dst.role).toBe(src.role)
          if (src.role === "user") {
            expect(dst.content).toBe(src.content)
            continue
          }
          const parts = dst.content as Array<Record<string, unknown>>
          expect(parts.length).toBe(src.content.length)
          for (let j = 0; j < src.content.length; j++) {
            const sp = src.content[j]! as Record<string, unknown>
            const dp = parts[j]!
            // An `options` key exists iff providerOptions is a non-null
            // object with ≥1 own key, and carries it verbatim.
            expect("options" in dp).toBe(hasKeys(sp["providerOptions"]))
            if ("options" in dp) expect(dp["options"]).toEqual(sp["providerOptions"])
            if (sp["type"] === "text" || sp["type"] === "reasoning") {
              expect(dp["type"]).toBe(sp["type"] as string)
              expect(dp["text"]).toBe(sp["text"] as string)
            } else if (sp["type"] === "tool-call") {
              expect(dp).toMatchObject({
                type: "tool-call",
                id: sp["toolCallId"],
                name: sp["toolName"],
                providerExecuted: sp["providerExecuted"] ?? false,
              })
              expect(dp["params"]).toEqual(sp["input"] ?? {})
            } else {
              expect(dp).toMatchObject({
                type: "tool-result",
                id: sp["toolCallId"],
                name: sp["toolName"],
                isFailure: sp["isError"] ?? false,
              })
              expect(dp["result"]).toEqual(sp["output"])
            }
          }
        }
      }),
      { numRuns: 100 },
    )
  })
})

// ─── attachUsageToAssistant / assistantUsage / recoverConversationStats ─────

describe("properties — usage embedding", () => {
  it("attach is idempotent and round-trips through assistantUsage", () => {
    fc.assert(
      fc.property(msgArrayArb, usageArb, (messages, usage) => {
        const arr = structuredClone(messages) as Array<AgentMessage>
        attachUsageToAssistant(arr, usage)
        const once = structuredClone(arr)
        attachUsageToAssistant(arr, usage)
        expect(arr).toEqual(once)
        const head = arr[0]
        if (head !== undefined && head.role === "assistant") {
          expect(assistantUsage(head)).toEqual(usage)
        }
      }),
      { numRuns: 100 },
    )
  })

  it("is a no-op unless the head is an assistant message", () => {
    fc.assert(
      fc.property(msgArrayArb, usageArb, (messages, usage) => {
        const arr = structuredClone(messages) as Array<AgentMessage>
        const before = structuredClone(arr)
        if (arr[0]?.role === "assistant") return
        attachUsageToAssistant(arr, usage)
        expect(arr).toEqual(before)
      }),
      { numRuns: 100 },
    )
  })

  it("preserves every prior providerOptions key except 'efferent'", () => {
    fc.assert(
      fc.property(msgArrayArb, usageArb, (messages, usage) => {
        const arr = structuredClone(messages) as Array<AgentMessage>
        const head = arr[0]
        if (head === undefined || head.role !== "assistant") return
        const prev =
          typeof head.providerOptions === "object" && head.providerOptions !== null
            ? structuredClone(head.providerOptions as Record<string, unknown>)
            : {}
        attachUsageToAssistant(arr, usage)
        const after = (arr[0] as { providerOptions: Record<string, unknown> }).providerOptions
        for (const [k, v] of Object.entries(prev)) {
          if (k === "efferent") continue // intentionally overwritten
          expect(after[k]).toEqual(v)
        }
        expect(after["efferent"]).toEqual(usage)
      }),
      { numRuns: 100 },
    )
  })

  it("recoverConversationStats sums exactly the attached usages, in order", () => {
    fc.assert(
      fc.property(fc.array(usageArb, { maxLength: 6 }), (usages) => {
        const messages: Array<AgentMessage> = []
        for (const u of usages) {
          messages.push({ role: "user", content: "q" })
          const turn: Array<AgentMessage> = [
            { role: "assistant", content: [{ type: "text", text: "a" }] } as AgentMessage,
          ]
          attachUsageToAssistant(turn, u)
          messages.push(...turn)
        }
        const stats = recoverConversationStats(messages)
        expect(stats.turns).toBe(usages.length)
        expect(stats.cumulativeOutput).toBe(usages.reduce((a, u) => a + u.outputTokens, 0))
        expect(stats.cumulativeTotal).toBe(usages.reduce((a, u) => a + u.totalTokens, 0))
        expect(stats.lastUsage).toEqual(usages[usages.length - 1])
      }),
      { numRuns: 100 },
    )
  })

  it("recoverConversationStats is total on arbitrary message arrays", () => {
    fc.assert(
      fc.property(msgArrayArb, (messages) => {
        const stats = recoverConversationStats(messages)
        expect(stats.turns).toBeGreaterThanOrEqual(0)
      }),
      { numRuns: 100 },
    )
  })
})

// ─── extractUsage / responseToAgentMessages ──────────────────────────────────

describe("properties — response mapping", () => {
  it("extractUsage is total on arbitrary usage blobs and content arrays", () => {
    // Content elements are filtered non-nullish: the helpers read `p.type`
    // on each element, which throws on null/undefined — real @effect/ai
    // response content never contains nullish elements, so the generator
    // excludes them rather than masking a non-bug.
    const contentArb = fc.array(
      fc.anything().filter((v) => v !== null && v !== undefined),
      { maxLength: 6 },
    )
    fc.assert(
      fc.property(fc.anything(), contentArb, (usage, content) => {
        const out = extractUsage(usage, content)
        expect(Object.keys(out).sort()).toEqual([
          "cacheReadTokens",
          "inputTokens",
          "outputTokens",
          "totalTokens",
        ])
      }),
      { numRuns: 200 },
    )
  })

  it("responseToAgentMessages partitions parts: assistant bucket / tool bucket / dropped", () => {
    const partArb = fc.record(
      {
        type: fc.constantFrom("text", "reasoning", "tool-call", "tool-result", "finish", "garbage"),
        text: fc.string({ maxLength: 20 }),
        id: fc.string({ maxLength: 8 }),
        name: fc.string({ maxLength: 8 }),
        params: fc.anything(),
        result: fc.anything(),
      },
      { requiredKeys: ["type"] },
    )
    fc.assert(
      fc.property(fc.array(partArb, { maxLength: 12 }), (parts) => {
        const out = responseToAgentMessages(parts)
        const assistantCount = parts.filter((p) =>
          ["text", "reasoning", "tool-call"].includes(p.type),
        ).length
        const toolCount = parts.filter((p) => p.type === "tool-result").length
        const assistantMsg = out.find((m) => m.role === "assistant")
        const toolMsg = out.find((m) => m.role === "tool")
        expect(assistantMsg !== undefined).toBe(assistantCount > 0)
        expect(toolMsg !== undefined).toBe(toolCount > 0)
        if (assistantMsg !== undefined) {
          expect((assistantMsg.content as Array<unknown>).length).toBe(assistantCount)
          // Relative order of assistant parts is preserved.
          const types = (assistantMsg.content as unknown as Array<{ type: string }>).map(
            (p) => p.type,
          )
          expect(types).toEqual(
            parts.filter((p) => ["text", "reasoning", "tool-call"].includes(p.type)).map((p) => p.type),
          )
        }
        if (toolMsg !== undefined) {
          expect((toolMsg.content as Array<unknown>).length).toBe(toolCount)
        }
        expect(out.length).toBe((assistantCount > 0 ? 1 : 0) + (toolCount > 0 ? 1 : 0))
      }),
      { numRuns: 200 },
    )
  })
})

// ─── example tests: provider-specific branches ───────────────────────────────

describe("extractUsage — provider branches", () => {
  const finish = (extra: Record<string, unknown>) => [{ type: "finish", ...extra }]

  it("folds Anthropic cache read + write back into inputTokens (both excluded upstream)", () => {
    const out = extractUsage(
      { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      finish({
        metadata: {
          anthropic: { usage: { cache_read_input_tokens: 100, cache_creation_input_tokens: 50 } },
        },
      }),
    )
    expect(out).toEqual({
      inputTokens: 160, // 10 + 100 + 50
      outputTokens: 5,
      totalTokens: 165, // recomputed fullInput + output, the reported 15 ignored
      cacheReadTokens: 100,
    })
  })

  it("an empty anthropic usage blob still folds (zeros), recomputing totals", () => {
    const out = extractUsage(
      { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      finish({ metadata: { anthropic: { usage: {} } } }),
    )
    expect(out).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 0 })
  })

  it("a null anthropic usage does not fold and does not throw", () => {
    const out = extractUsage(
      { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      finish({ metadata: { anthropic: { usage: null } } }),
    )
    expect(out).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 0 })
  })

  it("falls back to Gemini usageMetadata when no usage blob exists", () => {
    const out = extractUsage(
      undefined,
      finish({
        metadata: {
          google: {
            usageMetadata: {
              promptTokenCount: 7,
              candidatesTokenCount: 3,
              totalTokenCount: 10,
              cachedContentTokenCount: 4,
            },
          },
        },
      }),
    )
    expect(out).toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10, cacheReadTokens: 4 })
  })

  it("a usage-bearing finish part wins over a usage-less one (OpenCode double-finish)", () => {
    const out = extractUsage(undefined, [
      { type: "finish", reason: "stop" },
      { type: "finish", usage: { inputTokens: 9, outputTokens: 2, totalTokens: 11 } },
    ])
    expect(out.inputTokens).toBe(9)
    expect(out.outputTokens).toBe(2)
  })

  it("precedence: top-level usage beats finish usage beats usageMetadata", () => {
    const out = extractUsage({ inputTokens: 1 }, [
      {
        type: "finish",
        usage: { inputTokens: 2 },
        metadata: { google: { usageMetadata: { promptTokenCount: 3 } } },
      },
    ])
    expect(out.inputTokens).toBe(1)
  })
})

describe("response helpers + handoffToMessage", () => {
  const content = [
    { type: "text", text: "Hello " },
    { type: "reasoning", text: " thinking hard\n" },
    { type: "text", text: "world" },
    { type: "tool-call", id: "c1", name: "Bash", params: { command: "ls" } },
    { type: "tool-result", id: "c1", name: "Bash", result: { exitCode: 0 }, isFailure: false },
    { type: "tool-result", id: "c2", name: "grep", result: { error: "x" }, isFailure: true },
  ]

  it("responseText joins text parts; responseReasoning joins + trims reasoning parts", () => {
    expect(responseText(content)).toBe("Hello world")
    expect(responseReasoning(content)).toBe("thinking hard")
  })

  it("responseToolCalls / responseToolResults pair by id and map isFailure → !ok", () => {
    expect(responseToolCalls(content)).toEqual([
      { id: "c1", toolName: "Bash", args: { command: "ls" } },
    ])
    expect(responseToolResults(content)).toEqual([
      { id: "c1", toolName: "Bash", ok: true, result: { exitCode: 0 } },
      { id: "c2", toolName: "grep", ok: false, result: { error: "x" } },
    ])
  })

  it("handoffToMessage wraps the summary as a user-visible system note", () => {
    const msg = handoffToMessage("the summary")
    expect(msg.role).toBe("user")
    expect(msg.content).toContain("[System note:")
    expect((msg.content as string).endsWith("the summary")).toBe(true)
  })
})

// ─── ensureToolCallIds — deterministic id synthesis for id-less providers ─────

describe("ensureToolCallIds", () => {
  it("leaves a non-empty provider id untouched (today's good path)", () => {
    const content = [
      { type: "tool-call", id: "call_abc", name: "Bash", params: { command: "ls" } },
      { type: "tool-result", id: "call_abc", name: "Bash", result: { exitCode: 0 } },
    ]
    ensureToolCallIds(content, 0)
    expect(content[0]!.id).toBe("call_abc")
    expect(content[1]!.id).toBe("call_abc")
  })

  it("mints <turn>:<name>:<ordinal> for an id-less call AND its matching result, identically", () => {
    // What Gemini returns: a function call with no id, and a resolved result
    // also without one. The call and its result MUST end up with the same id
    // (the loop pairs them by id) — so the assistant tool-call ↔ tool-result
    // pairing stays valid.
    const content = [
      { type: "text", text: "running it" },
      { type: "tool-call", id: "", name: "grep", params: { pattern: "x" } },
      { type: "tool-result", id: "", name: "grep", result: "no matches" },
    ]
    ensureToolCallIds(content, 2)
    expect(content[1]!.id).toBe("2:grep:0")
    expect(content[2]!.id).toBe("2:grep:0") // same id → pairing intact
  })

  it("handles a missing `id` field (not just empty string)", () => {
    const content = [{ type: "tool-call", name: "ls", params: {} }] as Array<
      Record<string, unknown>
    >
    ensureToolCallIds(content, 1)
    expect(content[0]!["id"]).toBe("1:ls:0")
  })

  it("gives parallel id-less calls in one turn distinct ids, each paired to its result", () => {
    const content = [
      { type: "tool-call", id: "", name: "read", params: { path: "a" } },
      { type: "tool-call", id: "", name: "read", params: { path: "b" } },
      { type: "tool-result", id: "", name: "read", result: "A" },
      { type: "tool-result", id: "", name: "read", result: "B" },
    ]
    ensureToolCallIds(content, 0)
    expect(content[0]!.id).toBe("0:read:0")
    expect(content[1]!.id).toBe("0:read:1")
    // results pair by ordinal-among-results → match their call's id in order
    expect(content[2]!.id).toBe("0:read:0")
    expect(content[3]!.id).toBe("0:read:1")
  })

  it("the synthesized id is the SAME across event-path and persisted-path reads", () => {
    // The loop calls ensureToolCallIds ONCE, then reads `content` twice: via
    // responseToolCalls (→ the emitted tool_call_start event's `id`) and via
    // responseToAgentMessages (→ the persisted tool-call part's `toolCallId`).
    // Both must observe the identical synthesized id — that equality is what
    // makes the live rail pill and the re-projected pill share a key.
    const content = [
      { type: "tool-call", id: "", name: "edit_file", params: { path: "f" } },
      { type: "tool-result", id: "", name: "edit_file", result: "ok" },
    ]
    ensureToolCallIds(content, 3)

    const emittedId = responseToolCalls(content)[0]!.id // the event's `id`
    const msgs = responseToAgentMessages(content)
    const assistant = msgs.find((m) => m.role === "assistant")!
    const persistedCall = (
      assistant.content as unknown as Array<{ type: string; toolCallId?: string }>
    ).find((p) => p.type === "tool-call")!
    const toolMsg = msgs.find((m) => m.role === "tool")!
    const persistedResult = (toolMsg.content as unknown as Array<{ toolCallId: string }>)[0]!

    expect(emittedId).toBe("3:edit_file:0")
    expect(persistedCall.toolCallId).toBe("3:edit_file:0")
    expect(persistedResult.toolCallId).toBe("3:edit_file:0")
  })
})
