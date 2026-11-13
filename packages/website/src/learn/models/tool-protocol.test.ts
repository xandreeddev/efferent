import { describe, expect, test } from "bun:test"
import { Effect, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import type { Response } from "effect/ai"
import { callHolder, readCalls, textPrompt, withToolProtocol } from "./tool-protocol.ts"

const Add = Tool.make("add", { description: "Add two numbers.", parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }), success: Schema.Number })

describe("the text protocol for tools", () => {
  test("a call written as a block is read back, the text around it kept", () => {
    expect(readCalls('Sure. <tool_call>{"name": "add", "arguments": {"a": 2, "b": 3}}</tool_call>')).toEqual({ text: "Sure. ", calls: [{ name: "add", params: { a: 2, b: 3 } }] })
    // An unclosed block at the end still counts; one that is no JSON call stays text.
    expect(readCalls('<tool_call>{"name": "add", "arguments": {}}')).toEqual({ text: "", calls: [{ name: "add", params: {} }] })
    expect(readCalls("<tool_call>not json</tool_call>").calls).toEqual([])
  })

  test("streamed text is let through until a call might start, so a call never shows in the chat", () => {
    const holder = callHolder()
    expect(["Let me ", "add. <tool", '_call>{"name":"add","arguments":{"a":1,"b":1}}', "</tool_call>"].map(holder.feed)).toEqual(["Let me ", "add. ", "", ""])
    expect(holder.finish()).toEqual({ text: "", calls: [{ name: "add", params: { a: 1, b: 1 } }] })
  })

  test("a '<' that opens no call streams on, and text after a call keeps its spacing", () => {
    const holder = callHolder()
    expect(["if x < 3", " then", " stop"].map(holder.feed).join("")).toBe("if x < 3 then stop")
    const after = callHolder()
    expect(after.feed('Sure.<tool_call>{"name":"add","arguments":{}}</tool_call>\nDone.')).toBe("Sure.")
    expect(after.finish()).toEqual({ text: "\nDone.", calls: [{ name: "add", params: {} }] })
  })

  test("the prompt offers the tools in the system text and writes calls and results as text", () => {
    const prompt = textPrompt(Prompt.make([
      { role: "system", content: "Be brief." },
      { role: "user", content: "add" },
      { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "add", params: { a: 2, b: 3 } }] },
      { role: "tool", content: [{ type: "tool-result", id: "c1", name: "add", isFailure: false, result: 5 }] },
    ]), [Add])
    const [system, , call, result] = prompt.content
    expect(system?.role).toBe("system")
    // Model-facing text, pinned: one line per tool, and one example call.
    expect(system?.content).toBe([
      "Be brief.",
      "",
      "You have tools. To use one, reply with only a line like this, and nothing else:",
      '<tool_call>{"name":"add","arguments":{"a":1,"b":1}}</tool_call>',
      "Its result comes back inside <tool_response></tool_response>. Then answer the user in words.",
      "",
      "Tools:",
      "- add(a: number, b: number): Add two numbers.",
    ].join("\n"))
    expect(call?.content).toMatchObject([{ type: "text", text: '<tool_call>{"name":"add","arguments":{"a":2,"b":3}}</tool_call>' }])
    expect(result?.role).toBe("user")
  })

  test("a model that writes a block answers with a tool-call part", async () => {
    const impl = withToolProtocol({
      generateText: () => Effect.die("no"),
      streamText: () => Stream.fromIterable<Response.StreamPartEncoded>([
        { type: "text-delta", id: "t", delta: '<tool_call>{"name":"add","arguments":{"a":2,"b":3}}</tool_call>' },
        { type: "finish", reason: "stop", usage: { inputTokens: { total: 1, uncached: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
      ]),
    })
    const parts = await Effect.runPromise(Effect.gen(function* () {
      const model = yield* LanguageModel.make(impl)
      return yield* model.streamText({ prompt: Prompt.make("add 2 and 3"), toolkit: Toolkit.make(Add), disableToolCallResolution: true, toolCallValidation: "deferred" }).pipe(Stream.runCollect)
    }))
    expect(parts.map((part) => part.type)).toEqual(["tool-call", "finish"])
    expect(parts[0]).toMatchObject({ name: "add", params: { a: 2, b: 3 } })
  })
})
