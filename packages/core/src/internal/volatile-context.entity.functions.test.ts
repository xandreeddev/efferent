import { describe, expect, test } from "bun:test"
import type { Prompt } from "effect/ai"
import { ENGINE_KEY } from "../domain/engine-stamp.entity.js"
import { ToolCallId } from "../domain/message.entity.js"
import type { AgentMessage } from "../domain/message.entity.js"
import { toPromptMessages } from "./mapping.entity.functions.js"
import { isVolatileContext, markVolatileContext, stripVolatileContext } from "./volatile-context.entity.functions.js"

const messages: ReadonlyArray<AgentMessage> = [
  { role: "user", content: "history", providerOptions: { custom: { note: "keep" } } },
  { role: "assistant", content: [{ type: "text", text: "answer" }], providerOptions: { [ENGINE_KEY]: { model: "fixture", usage: { inputTokens: 2 } }, custom: { note: "also keep" } } },
  { role: "tool", content: [{ type: "tool-result", toolCallId: ToolCallId.make("call"), toolName: "lookup", output: { requestVolatile: true } }] },
]

describe("the neutral volatile-context marker", () => {
  test.each([0, 1, 2, 3])("marks only the first volatile message at prefix length %i without changing source data", (boundary) => {
    const before = JSON.stringify(messages)
    const marked = markVolatileContext(messages, boundary)
    expect(marked.map((message) => isVolatileContext(message.providerOptions ?? {}))).toEqual(messages.map((_, index) => index === boundary))
    expect(marked.map((message) => message.content)).toEqual(messages.map((message) => message.content))
    expect(JSON.stringify(messages)).toBe(before)
    expect(marked[boundary]?.providerOptions).toEqual(boundary === 1
      ? { [ENGINE_KEY]: { model: "fixture", usage: { inputTokens: 2 }, requestVolatile: true }, custom: { note: "also keep" } }
      : boundary < messages.length ? { ...messages[boundary]?.providerOptions, [ENGINE_KEY]: { requestVolatile: true } } : undefined)
  })

  test("empty and entirely stable contexts have no marker", () => {
    expect(markVolatileContext([], 0)).toEqual([])
    expect(markVolatileContext(messages, messages.length)).toEqual(messages)
  })

  test("recognizes only the exact true flag and leaves other options intact", () => {
    const unmarked: ReadonlyArray<Prompt.ProviderOptions> = [{}, { [ENGINE_KEY]: null }, { [ENGINE_KEY]: true }, { [ENGINE_KEY]: { requestVolatile: false } }, { [ENGINE_KEY]: { requestVolatile: "true" } }, { [ENGINE_KEY]: { model: "fixture" } }]
    unmarked.map((options) => {
      expect(isVolatileContext(options)).toBe(false)
      expect(stripVolatileContext(options)).toBe(options)
    })
  })

  test("strips only the recognized marker and removes an empty engine namespace", () => {
    const options: Prompt.ProviderOptions = { [ENGINE_KEY]: { requestVolatile: true, usage: { totalTokens: 3 }, other: "keep" }, custom: { exact: ["α", "\n"] } }
    const before = JSON.stringify(options)
    expect(stripVolatileContext(options)).toEqual({ [ENGINE_KEY]: { usage: { totalTokens: 3 }, other: "keep" }, custom: { exact: ["α", "\n"] } })
    expect(stripVolatileContext({ [ENGINE_KEY]: { requestVolatile: true }, custom: null })).toEqual({ custom: null })
    expect(JSON.stringify(options)).toBe(before)
  })

  test("mapping retains only recognized request bookkeeping for every message role and part", () => {
    const options = { [ENGINE_KEY]: { requestVolatile: true, model: "fixture", usage: { totalTokens: 3 }, other: "drop" }, custom: { exact: "value" } }
    const mapped = toPromptMessages([
      { role: "user", content: [{ type: "text", text: "tail", providerOptions: options }], providerOptions: options },
      { role: "assistant", content: [{ type: "reasoning", text: "signed", providerOptions: options }, { type: "tool-call", toolCallId: ToolCallId.make("call"), toolName: "lookup", input: {}, providerOptions: options }], providerOptions: options },
      { role: "tool", content: [{ type: "tool-result", toolCallId: ToolCallId.make("call"), toolName: "lookup", output: "result", providerOptions: options }], providerOptions: options },
    ])
    const sent = { [ENGINE_KEY]: { requestVolatile: true }, custom: { exact: "value" } }
    expect(mapped.map((message) => message.options)).toEqual([sent, sent, sent])
    expect(mapped.flatMap((message) => typeof message.content === "string" ? [] : message.content.map((part) => part.options))).toEqual([sent, sent, sent, sent])
  })
})
