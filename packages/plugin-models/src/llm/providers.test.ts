import { describe, expect, it } from "bun:test"
import { ConfigProvider, Effect, Option, Redacted } from "effect"
import { Prompt } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import { CurrentModelCallPolicy, CurrentPromptCacheKey, mediaFromBase64, mediaLabel, modelRequestDescriptorOf, parseModelSelection, ToolCallId, toPromptMessages } from "@xandreed/core"
import type { AgentMessage, ModelCallPolicy } from "@xandreed/core"
import type { Credential } from "@xandreed/core"
import { buildProvider, chatCompletionsUrl, OPENCODE_RESPONSES_API_URL, usesOpenCodeResponses } from "./providers.js"
import { CurrentModelEndpoints } from "../ports/model-endpoints.port.js"
import { ModelsTransport } from "../ports/models-transport.port.js"
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

const ask = (model: string, endpoints: ModelEndpoints, credential?: Credential, key?: string, config?: ConfigProvider.ConfigProvider) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const selection = yield* Effect.fromOption(parseModelSelection(model))
    const built = yield* buildProvider(selection, credential, key === undefined ? undefined : Redacted.make(key))
    return (yield* built.svc.generateText({ prompt: "hi" })).text
  })).pipe(
    Effect.provideService(CurrentModelEndpoints, endpoints),
    config === undefined ? (effect) => effect : Effect.provideService(ConfigProvider.ConfigProvider, config),
    Effect.provide(FetchHttpClient.layer),
  ))

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
    const env = ConfigProvider.fromEnvRecord({ EFFERENT_TEST_ENDPOINT_KEY: "env-key" })
    const run = Promise.all([
      ask("gw:m", { gw: { url: server.url, apiKey: "config-key", apiKeyEnv: "EFFERENT_TEST_ENDPOINT_KEY" } }, undefined, "stored-key", env),
      ask("gw:m", { gw: { url: server.url, apiKeyEnv: "EFFERENT_TEST_ENDPOINT_KEY" } }, undefined, "stored-key", env),
      ask("gw:m", { gw: { url: server.url, apiKeyEnv: "EFFERENT_TEST_UNSET_KEY" } }, undefined, "stored-key", env),
    ])
    await run.finally(() => server.stop())
    expect(server.seen.map((call) => call.auth).sort()).toEqual(["Bearer config-key", "Bearer env-key", "Bearer stored-key"])
  })

  it("sends no key for an empty own key, and never the stored one", async () => {
    const server = chatServer()
    const preserving = ConfigProvider.fromEnvRecord({ EFFERENT_TEST_EMPTY_KEY: "" }, { preserveEmptyStrings: true })
    const run = Promise.all([
      ask("gw:m", { gw: { url: server.url, apiKey: "" } }, undefined, "stored-key"),
      ask("gw:m", { gw: { url: server.url, apiKeyEnv: "EFFERENT_TEST_EMPTY_KEY" } }, undefined, "stored-key", preserving),
    ])
    await run.finally(() => server.stop())
    expect(server.seen.map((call) => call.auth)).toEqual([null, null])
  })

  it("reads apiKeyEnv through the ConfigProvider, where the environment's reads an empty variable as unset", async () => {
    const server = chatServer()
    const run = Promise.all([
      ask("gw:m", { gw: { url: server.url, apiKeyEnv: "GATEWAY_KEY" } }, undefined, "stored-key", ConfigProvider.fromEnvRecord({ GATEWAY_KEY: "provided-key" })),
      ask("gw:m", { gw: { url: server.url, apiKeyEnv: "GATEWAY_KEY" } }, undefined, "stored-key", ConfigProvider.fromEnvRecord({ GATEWAY_KEY: "" })),
    ])
    await run.finally(() => server.stop())
    expect(server.seen.map((call) => call.auth).sort()).toEqual(["Bearer provided-key", "Bearer stored-key"])
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

describe("images on the wire", () => {
  const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
  const image = Effect.runSync(mediaFromBase64(pixel, { name: "home.png" }))
  /** A user's question, a screenshot call, and its result with the image (as memory renders it). */
  const messages: ReadonlyArray<AgentMessage> = [
    { role: "user", content: "how does the home page look?" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: ToolCallId.make("call_1"), toolName: "screenshot", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: ToolCallId.make("call_1"), toolName: "screenshot", output: "Screenshot of home.", isError: false, media: [image] }] },
  ]
  const prompt = Prompt.make(toPromptMessages(messages) as Prompt.RawInput)

  /** Build the selection's model and send the prompt through a fetch that records each request body and refuses it. */
  const sent = (model: string, endpoints: ModelEndpoints = {}, credential?: Credential) => {
    const bodies: Array<Record<string, unknown>> = []
    const fetch = ((_url: unknown, init?: { readonly body?: unknown }) => {
      bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : new TextDecoder().decode(init?.body as Uint8Array)) as Record<string, unknown>)
      return Promise.resolve(Response.json({ type: "error", error: { type: "invalid_request_error", message: "recorded" } }, { status: 400 }))
    }) as typeof globalThis.fetch
    return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const selection = yield* Effect.fromOption(parseModelSelection(model))
      const built = yield* buildProvider(selection, credential, Redacted.make("test-key"))
      yield* Effect.exit(built.svc.generateText({ prompt }))
      return { bodies, images: built.images }
    })).pipe(
      Effect.provideService(CurrentModelEndpoints, endpoints),
      // Every route's requests reach the recording fetch: the SDK clients' and the chat-completions client's.
      Effect.provideService(ModelsTransport, ModelsTransport.of({ fetch })),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ))
  }

  it("Anthropic: the tool_result holds the result's text and an image block", async () => {
    const { bodies, images } = await sent("anthropic:claude-sonnet-5")
    expect(images).toBe(true)
    const messages = bodies[0]?.["messages"] as ReadonlyArray<{ readonly role: string; readonly content: ReadonlyArray<Record<string, unknown>> }>
    const result = messages.flatMap((message) => message.content).find((block) => block["type"] === "tool_result")
    expect(result).toMatchObject({
      tool_use_id: "call_1",
      content: [{ type: "text", text: "Screenshot of home." }, { type: "image", source: { type: "base64", media_type: "image/png", data: pixel } }],
    })
  })

  it("OpenAI Responses: the function_call_output holds input_text and input_image", async () => {
    const { bodies, images } = await sent("openai:gpt-5.5")
    expect(images).toBe(true)
    const output = (bodies[0]?.["input"] as ReadonlyArray<Record<string, unknown>>).find((item) => item["type"] === "function_call_output")
    expect(output).toMatchObject({
      call_id: "call_1",
      output: [{ type: "input_text", text: "Screenshot of home." }, { type: "input_image", image_url: `data:image/png;base64,${pixel}` }],
    })
  })

  it("a route that reads no images (OpenCode's chat models, an endpoint without images) is sent label lines; one with images: true the images", async () => {
    const chat = await sent("opencode:glm-5.2")
    expect(chat.images).toBe(false)
    expect(JSON.stringify(chat.bodies[0])).not.toContain(pixel)
    expect((chat.bodies[0]?.["messages"] as ReadonlyArray<Record<string, unknown>>).at(-1)).toEqual({ role: "tool", tool_call_id: "call_1", content: `Screenshot of home.\n${mediaLabel(image)}` })
    const plain = await sent("gw:vision", { gw: { url: "http://gw.invalid/v1" } })
    expect(JSON.stringify(plain.bodies[0])).not.toContain(pixel)
    const vision = await sent("gw:vision", { gw: { url: "http://gw.invalid/v1", images: true } })
    expect(vision.images).toBe(true)
    expect((vision.bodies[0]?.["messages"] as ReadonlyArray<Record<string, unknown>>).at(-1)).toEqual({ role: "user", content: [
      { type: "text", text: "Images returned by screenshot (call call_1):" }, { type: "image_url", image_url: { url: `data:image/png;base64,${pixel}` } },
    ] })
  })
})

describe("reasoning effort on the wire", () => {
  /** The request body a selection's model sends under a call policy, through a recording fetch that refuses it. */
  const sentUnder = (model: string, policy: ModelCallPolicy) => {
    const bodies: Array<Record<string, unknown>> = []
    const fetch = ((_url: unknown, init?: { readonly body?: unknown }) => {
      bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : new TextDecoder().decode(init?.body as Uint8Array)) as Record<string, unknown>)
      return Promise.resolve(Response.json({ error: { type: "invalid_request_error", message: "recorded" } }, { status: 400 }))
    }) as typeof globalThis.fetch
    return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const selection = yield* Effect.fromOption(parseModelSelection(model))
      const built = yield* buildProvider(selection, undefined, Redacted.make("test-key"))
      yield* Effect.exit(built.svc.generateText({ prompt: "hi" }))
      return bodies[0] ?? {}
    })).pipe(
      Effect.provideService(CurrentModelCallPolicy, Option.some(policy)),
      Effect.provideService(ModelsTransport, ModelsTransport.of({ fetch })),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ))
  }

  it("each route sends the call policy's effort in its own vocabulary; a model that takes none is sent none", async () => {
    const openai = await sentUnder("openai:gpt-5.5", { effort: "max", maxOutputTokens: 64 })
    expect(openai["reasoning"]).toEqual({ effort: "high" })
    expect(openai["max_output_tokens"]).toBe(64)
    expect(await sentUnder("openai:gpt-5.5", { effort: "none" })).toMatchObject({ reasoning: { effort: "low" } })
    expect(await sentUnder("openai:gpt-4.1", { effort: "high" })).not.toHaveProperty("reasoning")
    expect(await sentUnder("opencode:gpt-5.6-luna", { effort: "xhigh" })).toMatchObject({ reasoning: { effort: "high" } })
    expect(await sentUnder("opencode:glm-5.2", { effort: "max" })).toMatchObject({ reasoning_effort: "high" })
    expect(await sentUnder("opencode:glm-5.2", { effort: "medium" })).toMatchObject({ reasoning_effort: "medium" })
  })

  it("the openai route's descriptor records the effort it sends", async () => {
    const descriptor = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const selection = yield* Effect.fromOption(parseModelSelection("openai:gpt-5.5"))
      const built = yield* buildProvider(selection, undefined, Redacted.make("test-key"))
      return yield* modelRequestDescriptorOf(built.svc)
    })).pipe(
      Effect.provideService(CurrentModelCallPolicy, Option.some({ effort: "xhigh" })),
      Effect.provide(FetchHttpClient.layer),
    ))
    expect(Option.map(descriptor, (value) => value.settings)).toEqual(Option.some({ prompt_cache_key: "efferent", reasoning: { effort: "high" } }))
  })
})
