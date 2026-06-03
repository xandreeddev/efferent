import { describe, expect, it } from "bun:test"
import { Prompt, Tool } from "@effect/ai"
import { Schema } from "effect"
import { codexRequestBody, collectStreamParts } from "./openAiCodex.js"

const span = {} as never

describe("OpenAI Codex subscription adapter", () => {
  it("builds a Codex Responses request with instructions, tools, reasoning, and no stored response", () => {
    const prompt = Prompt.make([
      { role: "system", content: "Project rules" },
      { role: "user", content: "List files" },
    ] as never)
    const ListFiles = Tool.make("list_files", {
      description: "List files in the workspace",
      parameters: { path: Schema.String },
      success: Schema.Struct({ files: Schema.Array(Schema.String) }),
    })

    const body = codexRequestBody("gpt-5.5", {
      prompt,
      tools: [ListFiles],
      toolChoice: "auto",
      responseFormat: { type: "text" },
      span,
    })

    expect(body.instructions).toContain("Project rules")
    expect(body.input).toEqual([
      {
        role: "user",
        content: [{ type: "input_text", text: "List files" }],
      },
    ])
    expect(body.store).toBe(false)
    expect(body.stream).toBe(true)
    expect(body.reasoning).toEqual({ summary: "auto" })
    expect(body.include).toEqual(["reasoning.encrypted_content"])
    expect(body.tools).toEqual([
      expect.objectContaining({
        type: "function",
        name: "list_files",
        strict: false,
      }),
    ])
  })

  it("passes configured reasoning effort to Codex reasoning requests", () => {
    const prompt = Prompt.make([{ role: "user", content: "Think hard" }] as never)
    const body = codexRequestBody("gpt-5.5", {
      prompt,
      tools: [],
      toolChoice: "auto",
      responseFormat: { type: "text" },
      span,
    }, "high")

    expect(body.reasoning).toEqual({ summary: "auto", effort: "high" })
  })

  it("round-trips prior encrypted reasoning through input items", () => {
    const prompt = Prompt.make([
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "summary",
            options: {
              openai: { itemId: "rs_1", encryptedContent: "ciphertext" },
            },
          },
        ],
      },
    ] as never)

    const body = codexRequestBody("gpt-5.5", {
      prompt,
      tools: [],
      toolChoice: "none",
      responseFormat: { type: "text" },
      span,
    })

    expect(body.input).toEqual([
      {
        id: "rs_1",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "summary" }],
        encrypted_content: "ciphertext",
      },
    ])
  })

  it("collects streaming deltas into generateText parts without losing tool calls", () => {
    const parts = collectStreamParts([
      { type: "text-start", id: "msg_1" },
      { type: "text-delta", id: "msg_1", delta: "hel" },
      { type: "text-delta", id: "msg_1", delta: "lo" },
      { type: "text-end", id: "msg_1" },
      { type: "tool-call", id: "call_1", name: "list_files", params: { path: "." } },
      {
        type: "finish",
        reason: "tool-calls",
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
    ])

    expect(parts).toEqual([
      { type: "text", text: "hello", metadata: undefined },
      { type: "tool-call", id: "call_1", name: "list_files", params: { path: "." } },
      {
        type: "finish",
        reason: "tool-calls",
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
    ])
  })
})
