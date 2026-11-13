import { describe, expect, test } from "bun:test"
import { assistantMessage, toolResult } from "./conversation.entity.functions.js"

describe("the conversation's records", () => {
  test("the model's tool calls are kept as they came, their parameters as JSON", () => {
    expect(assistantMessage("Adding.", { toolCalls: [{ id: "c1", name: "add", params: { a: 2, b: 3 } }] }).message).toMatchObject({
      _tag: "Assistant", text: "Adding.", toolCalls: [{ id: "c1", name: "add", input: { a: 2, b: 3 } }],
    })
  })

  test("a tool's result is stored as JSON: nothing as null, a failure marked", () => {
    expect(toolResult({ id: "c1", name: "add" }, 5).message).toMatchObject({ _tag: "ToolResult", id: "c1", name: "add", result: 5, isFailure: false })
    expect(toolResult({ id: "c2", name: "log" }, undefined).message).toMatchObject({ _tag: "ToolResult", id: "c2", name: "log", result: null, isFailure: false })
    expect(toolResult({ id: "c3", name: "add" }, "cannot add", true).message).toMatchObject({ result: "cannot add", isFailure: true })
    // As JSON.stringify writes it: an undefined key left out, NaN as null.
    expect(toolResult({ id: "c4", name: "f" }, { a: 1, b: undefined, c: Number.NaN }).message).toMatchObject({ result: { a: 1, c: null } })
  })
})
