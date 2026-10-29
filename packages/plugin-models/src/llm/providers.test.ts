import { describe, expect, it } from "bun:test"
import { Effect, Option, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { CurrentModelCallPolicy, CurrentPromptCacheKey, modelRequestDescriptorOf, parseModelSelection } from "@xandreed/core"
import type { Credential } from "@xandreed/core"
import { buildProvider, chatCompletionsUrl, OPENCODE_RESPONSES_API_URL, usesOpenCodeResponses } from "./providers.js"
import { CurrentModelEndpoints } from "../ports/model-endpoints.port.js"
import type { ModelEndpoints } from "../ports/model-endpoints.port.js"
import { OPENAI_CODEX_API_URL, toOpenAiCodexRequestBody } from "./openAiCodex.js"
import { isOpenAiCodexControlEvent, normalizeOpenAiCodexWebSocketEvent, openAiCodexUuidV7 } from "./openAiCodexWebSocket.js"

describe("OpenCode protocol routing", () => {
  it("describes the SDK options captured at model construction, without credentials", async () => {
    const descriptor = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const selection = yield* Effect.fromOption(parseModelSelection("opencode:gpt-5.6-luna"))
      const built = yield* buildProvider(selection, undefined, Redacted.make("secret-test-key")).pipe(
        Effect.provideService(CurrentPromptCacheKey, Option.some("original-lane")),
        Effect.provideService(CurrentModelCallPolicy, Option.some({ effort: "max", maxOutputTokens: 32 })),
      )
      return yield* modelRequestDescriptorOf(built.svc).pipe(
        Effect.provideService(CurrentPromptCacheKey, Option.some("later-lane")),
        Effect.provideService(CurrentModelCallPolicy, Option.some({ effort: "low", maxOutputTokens: 64 })),
      )
    }).pipe(Effect.provide(FetchHttpClient.layer))))
    expect(descriptor).toEqual(Option.some({
      provider: "opencode", model: "gpt-5.6-luna",
      settings: { prompt_cache_key: "original-lane", strictJsonSchema: false, max_output_tokens: 32, reasoning: { effort: "high" } },
    }))
    expect(JSON.stringify(descriptor)).not.toContain("secret-test-key")
  })
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

  it("keeps transport timing out of the model stream without hiding errors or response events", () => {
    expect(isOpenAiCodexControlEvent("responsesapi.websocket_timing")).toBe(true)
    expect(isOpenAiCodexControlEvent("codex.rate_limits")).toBe(true)
    expect(isOpenAiCodexControlEvent("response.output_text.delta")).toBe(false)
    expect(isOpenAiCodexControlEvent("response.failed")).toBe(false)
    expect(isOpenAiCodexControlEvent("error")).toBe(false)
  })
})

/** A local OpenAI-compatible server that records each request's path, Authorization header and model. */
const chatServer = () => {
  const seen: Array<{ path: string; auth: string | null; model: unknown }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: async (request) => {
      const body = await request.json() as { readonly model?: unknown }
      seen.push({ path: new URL(request.url).pathname, auth: request.headers.get("authorization"), model: body.model })
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
    },
  })
  return { seen, url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) }
}

const ask = (model: string, endpoints: ModelEndpoints, credential?: Credential, key?: string) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const selection = yield* Effect.fromOption(parseModelSelection(model))
    const built = yield* buildProvider(selection, credential, key === undefined ? undefined : Redacted.make(key))
    return (yield* built.svc.generateText({ prompt: "hi" })).text
  })).pipe(Effect.provideService(CurrentModelEndpoints, endpoints), Effect.provide(FetchHttpClient.layer)))

describe("configured endpoints", () => {
  it("sends a named endpoint's models to its URL without a key", async () => {
    const server = chatServer()
    const text = await ask("local:llama3.1:8b", { local: { url: `${server.url}/` } }).finally(server.stop)
    expect(text).toBe("ok")
    expect(server.seen).toEqual([{ path: "/v1/chat/completions", auth: null, model: "llama3.1:8b" }])
    expect(chatCompletionsUrl("http://gw.example/v1//")).toBe("http://gw.example/v1/chat/completions")
  })

  it("takes the key from the endpoint, then its environment variable, then the stored credential", async () => {
    const server = chatServer()
    process.env["EFFERENT_TEST_ENDPOINT_KEY"] = "env-key"
    const run = Promise.all([
      ask("gw:m", { gw: { url: server.url, apiKey: "config-key", apiKeyEnv: "EFFERENT_TEST_ENDPOINT_KEY" } }, undefined, "stored-key"),
      ask("gw:m", { gw: { url: server.url, apiKeyEnv: "EFFERENT_TEST_ENDPOINT_KEY" } }, undefined, "stored-key"),
      ask("gw:m", { gw: { url: server.url, apiKeyEnv: "EFFERENT_TEST_UNSET_KEY" } }, undefined, "stored-key"),
    ])
    await run.finally(() => { server.stop(); delete process.env["EFFERENT_TEST_ENDPOINT_KEY"] })
    expect(server.seen.map((call) => call.auth).sort()).toEqual(["Bearer config-key", "Bearer env-key", "Bearer stored-key"])
  })

  it("sends no key for an empty own key, and never the stored one", async () => {
    const server = chatServer()
    process.env["EFFERENT_TEST_EMPTY_KEY"] = ""
    const run = Promise.all([
      ask("gw:m", { gw: { url: server.url, apiKey: "" } }, undefined, "stored-key"),
      ask("gw:m", { gw: { url: server.url, apiKeyEnv: "EFFERENT_TEST_EMPTY_KEY" } }, undefined, "stored-key"),
    ])
    await run.finally(() => { server.stop(); delete process.env["EFFERENT_TEST_EMPTY_KEY"] })
    expect(server.seen.map((call) => call.auth)).toEqual([null, null])
  })

  it("routes a local credential's base URL without a key", async () => {
    const server = chatServer()
    await ask("ollama:qwen3", {}, { type: "local", baseUrl: server.url }).finally(server.stop)
    expect(server.seen).toEqual([{ path: "/v1/chat/completions", auth: null, model: "qwen3" }])
  })

  it("lets an endpoint replace a built-in provider of the same name", async () => {
    const server = chatServer()
    await ask("openai:gpt-test", { openai: { url: server.url } }).finally(server.stop)
    expect(server.seen).toEqual([{ path: "/v1/chat/completions", auth: null, model: "gpt-test" }])
  })
})
