import { describe, expect, test } from "bun:test"
import { ToolCallId } from "@xandreed/core/kernel"
import type { Message } from "@xandreed/core/kernel"
import { estimateContext, estimateTokens, messageText, paired, promptMessage } from "./memory.entity.functions.js"

const call = (id: string) => ({ id: ToolCallId.make(id), name: "add", input: { a: 2, b: 3 } })
const asked = (text: string, ...ids: ReadonlyArray<string>): Message => ({ _tag: "Assistant", text, toolCalls: ids.map(call) })
const answered = (id: string): Message => ({ _tag: "ToolResult", id: ToolCallId.make(id), name: "add", result: 5, isFailure: false })

describe("memory's helpers", () => {
  test("a message of the conversation is the prompt message of its role, with its text", () => {
    expect(promptMessage({ _tag: "User", text: "Hello" })).toEqual({ role: "user", content: "Hello" })
    expect(promptMessage({ _tag: "Assistant", text: "Hi.", toolCalls: [] })).toEqual({ role: "assistant", content: "Hi." })
  })

  test("the model's tool calls are parts of its message, and a result is a tool message answering its call", () => {
    expect(promptMessage(asked("Let me add.", "c1"))).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Let me add." }, { type: "tool-call", id: "c1", name: "add", params: { a: 2, b: 3 } }],
    })
    expect(promptMessage(asked("", "c1"))).toEqual({ role: "assistant", content: [{ type: "tool-call", id: "c1", name: "add", params: { a: 2, b: 3 } }] })
    expect(promptMessage(answered("c1"))).toEqual({ role: "tool", content: [{ type: "tool-result", id: "c1", name: "add", result: 5, isFailure: false }] })
  })

  test("paired keeps a call only with its result and a result only with its call, and drops an answer left empty", () => {
    const user: Message = { _tag: "User", text: "add" }
    // c1 is answered; c2 was cut off by a stop; c3's call was cut off by a slice.
    expect(paired([user, asked("", "c1", "c2"), answered("c1"), answered("c3")])).toEqual([user, asked("", "c1"), answered("c1")])
    expect(paired([user, asked("", "c2")])).toEqual([user])
    expect(paired([user, asked("Thinking.", "c2")])).toEqual([user, asked("Thinking.")])
  })

  test("the estimate is a quarter of the characters, rounded up, summed over a context, tool traffic counted", () => {
    expect([estimateTokens(""), estimateTokens("abcd"), estimateTokens("abcde")].map(Number)).toEqual([0, 1, 2])
    expect(Number(estimateContext([{ role: "user", content: "abcde" }, { role: "assistant", content: [{ type: "text", text: "abcd" }] }]))).toBe(3)
    expect(Number(estimateContext([promptMessage(asked("", "c1")), promptMessage(answered("c1"))]))).toBe(Number(estimateTokens("add {\"a\":2,\"b\":3}")) + 1)
    expect(messageText(asked("Sure.", "c1"))).toBe("Sure. add {\"a\":2,\"b\":3}")
    expect(messageText(answered("c1"))).toBe("5")
  })
})
