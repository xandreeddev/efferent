import { describe, expect, test } from "bun:test"
import { estimateContext, estimateTokens, promptMessage } from "./memory.entity.functions.js"

describe("memory's helpers", () => {
  test("a message of the conversation is the prompt message of its role, with its text", () => {
    expect(promptMessage({ _tag: "User", text: "Hello" })).toEqual({ role: "user", content: "Hello" })
    expect(promptMessage({ _tag: "Assistant", text: "Hi.", toolCalls: [] })).toEqual({ role: "assistant", content: "Hi." })
  })

  test("the estimate is a quarter of the characters, rounded up, summed over a context", () => {
    expect([estimateTokens(""), estimateTokens("abcd"), estimateTokens("abcde")].map(Number)).toEqual([0, 1, 2])
    expect(Number(estimateContext([{ role: "user", content: "abcde" }, { role: "assistant", content: [{ type: "text", text: "abcd" }] }]))).toBe(3)
  })
})
