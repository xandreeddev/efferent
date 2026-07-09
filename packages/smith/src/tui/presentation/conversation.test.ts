import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import type { LoopEvent } from "@xandreed/engine"
import type { SmithEvent } from "../../domain/SmithEvent.js"
import {
  contextGauge,
  contextTokens,
  initialConversation,
  reduceConversation,
  withUserBlock,
} from "./conversation.js"

const agent = (event: LoopEvent): SmithEvent => ({ type: "agent", event })

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0 }

describe("the conversation fold", () => {
  test("tool lifecycle: running → ok/fail, matched by id", () => {
    const state = [
      agent({ type: "tool_start", turnIndex: 0, toolCallId: "t1", toolName: "read_file", args: { path: "a.ts" } }),
      agent({ type: "tool_start", turnIndex: 0, toolCallId: "t2", toolName: "bash", args: { command: "bun test" } }),
      agent({ type: "tool_end", turnIndex: 0, toolCallId: "t1", toolName: "read_file", args: {}, ok: true, result: {} }),
      agent({ type: "tool_end", turnIndex: 0, toolCallId: "t2", toolName: "bash", args: {}, ok: false, result: {} }),
    ].reduce(reduceConversation, initialConversation)
    expect(state.blocks).toEqual([
      { kind: "tool", id: "t1", name: "read_file", arg: "a.ts", status: "ok" },
      { kind: "tool", id: "t2", name: "bash", arg: "bun test", status: "fail" },
    ])
  })

  test("a THINKING turn: the ▸ header carries the meta; the reply carries none", () => {
    const state = reduceConversation(
      withUserBlock(initialConversation, "port the module"),
      agent({
        type: "assistant_message",
        turnIndex: 0,
        text: "Done — two files written.",
        reasoning: "The Python module maps to two TS files because…",
        model: "opencode:kimi-k2.7-code",
        toolCalls: [],
        usage,
      }),
    )
    expect(state.blocks[0]).toEqual({ kind: "user", text: "port the module" })
    expect(state.blocks[1]).toEqual({
      kind: "reasoning",
      text: "The Python module maps to two TS files because…",
      tag: "opencode:kimi-k2.7-code · turn 1 in · 1 out",
      tokens: { input: 1, output: 1, cached: 0 },
    })
    expect(state.blocks[2]).toEqual({
      kind: "assistant",
      text: "Done — two files written.",
      tag: "opencode:kimi-k2.7-code · turn 1 in · 1 out",
      leading: false,
      tokens: { input: 1, output: 1, cached: 0 },
    })
  })

  test("a REASONING-ONLY turn emits just the header — no empty reply block", () => {
    const state = reduceConversation(
      initialConversation,
      agent({
        type: "assistant_message",
        turnIndex: 0,
        text: " ",
        reasoning: "exploring first",
        toolCalls: [],
        usage,
      }),
    )
    expect(state.blocks.map((b) => b.kind)).toEqual(["reasoning"])
    expect(Option.getOrThrow(contextTokens(state))).toBe(1)
  })

  test("a tool-only turn (no thought) still lands its LEADING tag block; unrelated events are inert", () => {
    const state = [
      agent({ type: "assistant_message", turnIndex: 0, text: "  ", reasoning: "", toolCalls: [], usage }),
      { type: "refine_start", idea: Option.none() } satisfies SmithEvent,
    ].reduce(reduceConversation, initialConversation)
    expect(state.blocks).toEqual([
      {
        kind: "assistant",
        text: "",
        tag: "turn 1 in · 1 out",
        leading: true,
        tokens: { input: 1, output: 1, cached: 0 },
      },
    ])
  })

  test("the tag shows the CACHED share of input when the prefix cache hit", () => {
    const state = reduceConversation(
      initialConversation,
      agent({
        type: "assistant_message",
        turnIndex: 0,
        text: "ok",
        reasoning: "",
        model: "opencode:kimi-k2.6",
        toolCalls: [],
        usage: { inputTokens: 15_600, outputTokens: 135, totalTokens: 15_735, cacheReadTokens: 14_336 },
      }),
    )
    const assistant = state.blocks[0]
    expect(assistant?.kind).toBe("assistant")
    if (assistant?.kind !== "assistant") return
    expect(assistant.tag).toBe("opencode:kimi-k2.6 · turn 15.6k in (14.3k cached) · 135 out")
  })

  test("contextTokens reads the LATEST turn's input; the gauge formats", () => {
    const state = [
      agent({ type: "assistant_message", turnIndex: 0, text: "a", reasoning: "", toolCalls: [], usage }),
      agent({
        type: "assistant_message",
        turnIndex: 1,
        text: "b",
        reasoning: "",
        toolCalls: [],
        usage: { inputTokens: 17_900, outputTokens: 85, totalTokens: 17_985, cacheReadTokens: 0 },
      }),
    ].reduce(reduceConversation, initialConversation)
    expect(Option.getOrThrow(contextTokens(state))).toBe(17_900)
    expect(Option.isNone(contextTokens(initialConversation))).toBe(true)
    expect(
      Option.getOrThrow(contextGauge(Option.some(17_900), Option.some(256_000))),
    ).toBe("ctx 17.9k/256k (7%)")
    expect(Option.getOrThrow(contextGauge(Option.some(500), Option.none()))).toBe("ctx 500")
  })

  test("a PARTIAL agent_end lands as a durable ⚠ notice; ok ends are inert", () => {
    // The invisible step-cap: 16 exploration turns, then silence — the run
    // "completed" as partial and the pane showed NOTHING (live-caught).
    const capped = reduceConversation(
      initialConversation,
      agent({ type: "agent_end", outcome: "partial", reason: "step-cap", finalText: "" }),
    )
    expect(capped.blocks).toHaveLength(1)
    const notice = capped.blocks[0]
    expect(notice?.kind).toBe("notice")
    if (notice?.kind !== "notice") return
    expect(notice.text).toContain("step ceiling")
    expect(notice.text).toContain("continue")
    const ok = reduceConversation(
      initialConversation,
      agent({ type: "agent_end", outcome: "ok", reason: "completed", finalText: "done" }),
    )
    expect(ok.blocks).toEqual([])
  })

  test("refine_error lands as a DURABLE error block in the story", () => {
    const state = reduceConversation(initialConversation, {
      type: "refine_error",
      message: "the opencode request exceeded 300s and was cut off",
    })
    expect(state.blocks).toEqual([
      { kind: "error", text: "the opencode request exceeded 300s and was cut off" },
    ])
  })
})
