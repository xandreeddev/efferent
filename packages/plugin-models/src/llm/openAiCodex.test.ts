import { describe, expect, test } from "bun:test"
import { toOpenAiCodexRequestBody } from "./openAiCodex.js"

describe("toOpenAiCodexRequestBody", () => {
  test("joins the text parts of every system and developer message into the instructions; other messages stay the input", () => {
    const request = toOpenAiCodexRequestBody({
      model: "gpt-5.6-luna",
      input: [
        { role: "system", content: [{ type: "input_text", text: "First." }, { type: "input_image", image_url: "data:" }, { type: "input_text", text: "Second." }] },
        { role: "developer", content: "Third." },
        { role: "developer", content: [{ type: "input_image", image_url: "data:" }] },
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
      text: { verbosity: "medium", format: { type: "json_schema" } },
      reasoning: { summary: "detailed" },
      tool_choice: "required",
      parallel_tool_calls: false,
    }, "high")
    expect(request).toEqual({
      model: "gpt-5.6-luna",
      store: false,
      stream: true,
      instructions: "First.\n\nSecond.\n\nThird.",
      input: [
        { role: "developer", content: [{ type: "input_image", image_url: "data:" }] },
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
      text: { verbosity: "medium" },
      include: ["reasoning.encrypted_content"],
      tool_choice: "required",
      parallel_tool_calls: false,
      reasoning: { summary: "auto", effort: "high" },
    })
  })

  test("a body that is not a Responses request object reads as an empty one", () => {
    const empty = {
      store: false,
      stream: true,
      instructions: "You are a helpful assistant.",
      input: [],
      text: { verbosity: "low" },
      include: ["reasoning.encrypted_content"],
      tool_choice: "auto",
      parallel_tool_calls: true,
    }
    expect(toOpenAiCodexRequestBody("not an object")).toEqual(empty)
    expect(toOpenAiCodexRequestBody({ input: "hi" })).toEqual(empty)
  })
})
