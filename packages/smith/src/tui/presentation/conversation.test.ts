import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import type { LoopEvent } from "@xandreed/engine"
import type { SmithEvent } from "../../domain/SmithEvent.js"
import { initialConversation, reduceConversation, withUserBlock } from "./conversation.js"

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

  test("REASONING is a first-class block; assistant text carries its model", () => {
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
    })
    const assistant = state.blocks[2]
    expect(assistant?.kind).toBe("assistant")
    if (assistant?.kind !== "assistant") return
    expect(assistant.text).toBe("Done — two files written.")
    expect(Option.getOrThrow(assistant.model)).toBe("opencode:kimi-k2.7-code")
    expect(assistant.tokens).toEqual({ input: 1, output: 1 })
  })

  test("a tool-only turn still lands its tag block; unrelated events are inert", () => {
    const state = [
      agent({ type: "assistant_message", turnIndex: 0, text: "  ", reasoning: "", toolCalls: [], usage }),
      { type: "refine_start", idea: Option.none() } satisfies SmithEvent,
    ].reduce(reduceConversation, initialConversation)
    expect(state.blocks).toEqual([
      { kind: "assistant", text: "", model: Option.none(), tokens: { input: 1, output: 1 } },
    ])
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
