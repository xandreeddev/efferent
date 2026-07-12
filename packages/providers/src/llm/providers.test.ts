import { describe, expect, it } from "bun:test"
import { OPENCODE_RESPONSES_API_URL, usesOpenCodeResponses } from "./providers.js"
import { OPENAI_CODEX_API_URL, toOpenAiCodexRequestBody } from "./openAiCodex.js"
import { normalizeOpenAiCodexWebSocketEvent, openAiCodexUuidV7 } from "./openAiCodexWebSocket.js"

describe("OpenCode protocol routing", () => {
  it("routes GPT 5.6 Luna through the Responses API", () => {
    expect(usesOpenCodeResponses("gpt-5.6-luna")).toBe(true)
    expect(OPENCODE_RESPONSES_API_URL).toBe("https://opencode.ai/zen/v1")
  })

  it("keeps non-GPT models on the chat-completions adapter", () => {
    expect(usesOpenCodeResponses("glm-5.2")).toBe(false)
    expect(usesOpenCodeResponses("deepseek-v4-flash")).toBe(false)
  })
})

describe("OpenAI subscription adapter", () => {
  it("moves system instructions out of the Codex conversation input", () => {
    const request = toOpenAiCodexRequestBody({
      input: [
        { role: "developer", content: "Use the governed UI tools." },
        { role: "user", content: [{ type: "input_text", text: "Build a recipe app" }] },
      ],
      tools: [{ type: "function", name: "start_ui" }],
    })
    expect(request["instructions"]).toBe("Use the governed UI tools.")
    expect(request["input"]).toEqual([{ role: "user", content: [{ type: "input_text", text: "Build a recipe app" }] }])
    expect(request["store"]).toBe(false)
    expect(OPENAI_CODEX_API_URL).toBe("https://chatgpt.com/backend-api/codex")
  })

  it("forces the streaming dialect and drops unsupported output caps", () => {
    const request = toOpenAiCodexRequestBody({
      model: "gpt-5.6-luna",
      stream: false,
      max_output_tokens: 64,
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    }, "max")
    expect(request["stream"]).toBe(true)
    expect(request["max_output_tokens"]).toBeUndefined()
    expect(request["instructions"]).toBe("You are a helpful assistant.")
    expect(request["reasoning"]).toEqual({ effort: "max", summary: "auto" })
  })

  it("uses UUIDv7 for subscription routing and normalizes its terminal event", () => {
    const id = openAiCodexUuidV7(1_781_234_567_890)
    expect(id[14]).toBe("7")
    expect(["8", "9", "a", "b"]).toContain(id[19]!)
    expect(normalizeOpenAiCodexWebSocketEvent({ type: "response.done", response: { status: "completed" } }))
      .toEqual({ type: "response.completed", response: { status: "completed" } })
  })
})
