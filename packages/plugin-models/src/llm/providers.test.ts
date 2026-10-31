import { describe, expect, it } from "bun:test"
import { ConfigProvider, Effect, Exit, Metric, Option, Redacted, Schema, Stream } from "effect"
import { Prompt } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import { CurrentModelCallPolicy, CurrentPromptCacheKey, mediaFromBase64, mediaLabel, modelRequestDescriptorOf, parseModelSelection, ToolCallId } from "@xandreed/core"
import { foldStreamParts, responseToAgentMessages, toPromptMessages } from "@xandreed/core/internal"
import type { AgentMessage, ModelCallPolicy } from "@xandreed/core"
import type { Credential } from "../ports/auth-store.port.js"
import { buildProvider, chatCompletionsUrl, OPENCODE_RESPONSES_API_URL, prependClaudeCode, usesOpenCodeResponses, withAnthropicCacheBreakpoints } from "./providers.js"
import type { BuiltProvider } from "./providers.js"
import { CurrentModelEndpoints } from "../ports/model-endpoints.port.js"
import { ModelsTransport } from "../ports/models-transport.port.js"
import type { ModelEndpoints } from "../ports/model-endpoints.port.js"
import { CurrentThinkingPrefixMismatch } from "../ports/thinking-binding.port.js"
import { ANTHROPIC_OAUTH_BETA } from "../auth/anthropicOAuth.js"
import { THINKING_BINDING_BETA } from "./thinking-binding.entity.js"
import type { ThinkingPrefixMismatch } from "./thinking-binding.entity.js"
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

describe("call options", () => {
  it("cache breakpoints mark the last system message and the last two others, keep the other options and leave an explicit cacheControl alone", () => {
    const shaped = withAnthropicCacheBreakpoints({
      prompt: [
        { role: "system", content: "rules" },
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three", options: { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } } },
      ],
      toolChoice: "none" as const,
    })
    expect(shaped.toolChoice).toBe("none")
    expect(shaped.prompt.content.map((message) => message.options["anthropic"] ?? null)).toEqual([
      { cacheControl: { type: "ephemeral" } },
      null,
      { cacheControl: { type: "ephemeral" } },
      { cacheControl: { type: "ephemeral", ttl: "1h" } },
    ])
  })

  it("the Claude Code block goes first and the other options are kept", () => {
    const shaped = prependClaudeCode({ prompt: [{ role: "system", content: "rules" }, { role: "user", content: "hi" }], toolChoice: "auto" as const })
    expect(shaped.toolChoice).toBe("auto")
    expect(shaped.prompt.content.map((message) => message.role)).toEqual(["system", "system", "user"])
    expect(shaped.prompt.content[0]?.content).toBe("You are Claude Code, Anthropic's official CLI for Claude.")
  })

  it("a built model names its route: a configured endpoint's and a local credential's are compat", async () => {
    const routeOf = (model: string, endpoints: ModelEndpoints = {}, credential?: Credential) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const selection = yield* Effect.fromOption(parseModelSelection(model))
      return (yield* buildProvider(selection, credential, Redacted.make("test-key"))).route
    })).pipe(Effect.provideService(CurrentModelEndpoints, endpoints), Effect.provide(FetchHttpClient.layer)))
    expect(await Promise.all([
      routeOf("anthropic:claude-sonnet-5"),
      routeOf("openai:gpt-5.5"),
      routeOf("opencode:gpt-5.6-luna"),
      routeOf("opencode:glm-5.2"),
      routeOf("google:gemini-3.5-flash"),
      routeOf("openai-codex:gpt-5.5", {}, { type: "oauth", access: Redacted.make("a"), refresh: Redacted.make("r"), expires: 1, accountId: "account" }),
      routeOf("anthropic:claude-sonnet-5", { anthropic: { url: "http://127.0.0.1:1/v1" } }),
      routeOf("ollama:qwen3", {}, { type: "local", baseUrl: "http://127.0.0.1:1/v1" }),
    ])).toEqual(["anthropic", "openai-responses", "openai-responses", "compat", "compat", "openai-codex", "compat", "compat"])
  })
})

describe("thinking on the wire", () => {
  interface Sent { readonly url: string; readonly beta: string; readonly body: Record<string, unknown> }

  /** A Messages API reply: settled JSON, or a server-sent stream of `events`. */
  const settled = (content: ReadonlyArray<Record<string, unknown>>, extra: Record<string, unknown> = {}) => () => Response.json({
    id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 2 }, ...extra,
  })
  const streamed = (events: ReadonlyArray<Record<string, unknown>>) => () => new Response(
    events.map((event) => `event: ${String(event["type"])}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  )

  /** Build the selection's model under `mismatch` and run `call` through a fetch that records each request and gives `reply`. */
  const exchange = <A>(model: string, options: {
    readonly reply: () => Response
    readonly call: (svc: BuiltProvider["svc"]) => Effect.Effect<A, unknown>
    readonly mismatch?: ThinkingPrefixMismatch
    readonly credential?: Credential
  }) => {
    const sent: Array<Sent> = []
    const fetch = ((input: unknown, init?: { readonly body?: unknown; readonly headers?: HeadersInit }) => {
      const body = typeof init?.body === "string" ? init.body : new TextDecoder().decode(init?.body as Uint8Array)
      sent.push({ url: String(input), beta: new Headers(init?.headers).get("anthropic-beta") ?? "", body: JSON.parse(body) as Record<string, unknown> })
      return Promise.resolve(options.reply())
    }) as typeof globalThis.fetch
    return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const selection = yield* Effect.fromOption(parseModelSelection(model))
      const built = yield* buildProvider(selection, options.credential, Redacted.make("test-key"))
      const result = yield* Effect.exit(options.call(built.svc))
      const descriptor = yield* modelRequestDescriptorOf(built.svc)
      return { sent, result, descriptor }
    })).pipe(
      Effect.provideService(CurrentThinkingPrefixMismatch, options.mismatch ?? "provider-default"),
      Effect.provideService(ModelsTransport, ModelsTransport.of({ fetch })),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ))
  }

  /** An earlier turn whose reply thought (signed), thought redacted, then called a tool; then the tool's result. */
  const replayed = Prompt.make([
    { role: "user", content: "list the files" },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "I should list them.", options: { anthropic: { info: { type: "thinking", signature: "sig/+=abc-0123" } } } },
        { type: "reasoning", text: "", options: { anthropic: { info: { type: "redacted_thinking", redactedData: "redacted+/=xyz" } } } },
        { type: "tool-call", id: "toolu_1", name: "ls", params: { path: "." }, providerExecuted: false },
      ],
    },
    { role: "tool", content: [{ type: "tool-result", id: "toolu_1", name: "ls", isFailure: false, result: "a.txt" }] },
  ] as Prompt.RawInput)

  it("a stored reply's signed and redacted thinking go back byte for byte, in order, before its tool call", async () => {
    const { sent } = await exchange("anthropic:claude-opus-5-5", { reply: settled([{ type: "text", text: "done" }]), call: (svc) => svc.generateText({ prompt: replayed }) })
    const assistant = (sent[0]?.body["messages"] as ReadonlyArray<{ readonly role: string; readonly content: ReadonlyArray<Record<string, unknown>> }>)[1]
    expect(assistant?.content.map((block) => block["type"])).toEqual(["thinking", "redacted_thinking", "tool_use"])
    expect(assistant?.content[0]).toMatchObject({ type: "thinking", thinking: "I should list them.", signature: "sig/+=abc-0123" })
    expect(assistant?.content[1]).toEqual({ type: "redacted_thinking", data: "redacted+/=xyz" })
  })

  const thinkingContent = [
    { type: "thinking", thinking: "Let me think.", signature: "sig-stream" },
    { type: "redacted_thinking", data: "redacted-stream" },
    { type: "text", text: "ok" },
  ]
  const thinkingEvents: ReadonlyArray<Record<string, unknown>> = [
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me think." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-stream" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "redacted-stream" } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ]

  it("a streamed reply folds to the thinking a settled one keeps: the same reasoning, signature and redacted data", async () => {
    const reasoningOf = (messages: ReadonlyArray<AgentMessage>) => messages.flatMap((message) =>
      typeof message.content === "string" ? [] : message.content.flatMap((part) => part.type === "reasoning" ? [{ text: part.text, metadata: "providerOptions" in part ? part.providerOptions : undefined }] : []))
    const fromSettled = await exchange("anthropic:claude-opus-5-5", {
      reply: settled(thinkingContent),
      call: (svc) => svc.generateText({ prompt: "hi" }).pipe(Effect.map((response) => responseToAgentMessages(response.content))),
    })
    const fromStream = await exchange("anthropic:claude-opus-5-5", {
      reply: streamed(thinkingEvents),
      call: (svc) => foldStreamParts(svc.streamText({ prompt: "hi" }), () => Effect.void).pipe(Effect.map((folded) => responseToAgentMessages(folded.content))),
    })
    const settledReasoning = Exit.match(fromSettled.result, { onFailure: () => [], onSuccess: reasoningOf })
    expect(settledReasoning.length).toBe(2)
    expect(Exit.match(fromStream.result, { onFailure: () => [], onSuccess: reasoningOf })).toEqual(settledReasoning)
  })

  const blockBinding = (sent: Sent) => (sent.body["thinking"] as Record<string, unknown> | undefined)?.["block_binding"]

  it("the binding follows the mismatch setting for adaptive binding models, and the descriptor records resolved controls", async () => {
    const off = await exchange("anthropic:claude-opus-5-5", { reply: settled([{ type: "text", text: "ok" }]), call: (svc) => svc.generateText({ prompt: "hi" }) })
    expect([off.sent[0]?.body["thinking"], off.sent[0]?.beta.includes(THINKING_BINDING_BETA)]).toEqual([{ type: "adaptive", display: "summarized" }, false])
    const on = await exchange("anthropic:claude-opus-5-5", { mismatch: "drop_block", reply: settled([{ type: "text", text: "ok" }]), call: (svc) => svc.generateText({ prompt: "hi" }) })
    expect(on.sent[0]?.body["thinking"]).toEqual({ type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } })
    expect(on.sent[0]?.beta.split(",")).toContain(THINKING_BINDING_BETA)
    expect(Option.map(on.descriptor, (value) => value.settings)).toEqual(Option.some({ model: "claude-opus-5-5", max_tokens: 128_000, output_config: { effort: "medium" }, thinking: { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } }, systemPrelude: null, thinkingPrefixMismatch: "drop_block" }))
    const refusing = await exchange("anthropic:claude-sonnet-5-5", { mismatch: "error", reply: settled([{ type: "text", text: "ok" }]), call: (svc) => svc.generateText({ prompt: "hi" }) })
    expect(blockBinding(refusing.sent[0]!)).toEqual({ prefix_mismatch_behavior: "error" })
    const older = await exchange("anthropic:claude-opus-4-8", { mismatch: "drop_block", reply: settled([{ type: "text", text: "ok" }]), call: (svc) => svc.generateText({ prompt: "hi" }) })
    expect([older.sent[0]?.body["thinking"], older.sent[0]?.beta.includes(THINKING_BINDING_BETA)]).toEqual([{ type: "disabled" }, false])
    expect(Option.map(older.descriptor, (value) => value.settings)).toEqual(Option.some({ model: "claude-opus-4-8", max_tokens: 128_000, output_config: { effort: "high" }, thinking: { type: "disabled" }, systemPrelude: null }))
  })

  it("the subscription route adds its betas to the client's own, the binding's included, instead of replacing them", async () => {
    const oauth: Credential = { type: "oauth", access: Redacted.make("access"), refresh: Redacted.make("refresh"), expires: 4_102_444_800_000 }
    const { sent } = await exchange("anthropic:claude-opus-5-5", {
      credential: oauth,
      mismatch: "drop_block",
      reply: settled([{ type: "text", text: "ok" }]),
      // A document part has the client add a beta of its own (its PDF and text documents).
      call: (svc) => svc.generateText({ prompt: Prompt.make([{ role: "user", content: [{ type: "text", text: "read it" }, { type: "file", mediaType: "text/plain", data: "aGVsbG8=" }] }] as Prompt.RawInput) }),
    })
    const betas = sent[0]?.beta.split(",") ?? []
    expect(betas).toEqual(expect.arrayContaining([...ANTHROPIC_OAUTH_BETA.split(","), THINKING_BINDING_BETA]))
    expect(betas.length).toBeGreaterThan(ANTHROPIC_OAUTH_BETA.split(",").length + 1)
    expect(new Set(betas).size).toBe(betas.length)
  })

  const droppedCount = (label: string, reason: string) => Effect.runPromise(Metric.value(Metric.withAttributes(
    Metric.counter("llm.thinking.dropped", { description: "thinking blocks the provider dropped from a request whose conversation changed before them", incremental: true }),
    { "llm.model": label, reason },
  ))).then((state) => state.count)

  it("the thinking blocks the provider dropped are counted by reason, from a settled body and from a stream's first event; the reply is unchanged", async () => {
    const dropped = [{ type: "thinking_dropped", reason: "prefix_binding_mismatch" }, { type: "thinking_dropped", reason: "prefix_binding_mismatch" }, { type: "thinking_mismatch_allowed" }]
    const before = await droppedCount("anthropic:claude-fable-5-1", "prefix_binding_mismatch")
    const plain = await exchange("anthropic:claude-fable-5-1", {
      mismatch: "drop_block",
      reply: settled([{ type: "text", text: "ok" }], { input_transformations: dropped }),
      call: (svc) => svc.generateText({ prompt: "hi" }).pipe(Effect.map((response) => response.text)),
    })
    expect(Exit.match(plain.result, { onFailure: () => "failed", onSuccess: (text) => text })).toBe("ok")
    expect(await droppedCount("anthropic:claude-fable-5-1", "prefix_binding_mismatch")).toBe(before + 2)
    const [start, ...rest] = thinkingEvents
    const stream = await exchange("anthropic:claude-fable-5-1", {
      mismatch: "drop_block",
      reply: streamed([{ ...start, message: { ...(start?.["message"] as Record<string, unknown>), input_transformations: dropped.slice(0, 1) } }, ...rest]),
      call: (svc) => Stream.runCollect(svc.streamText({ prompt: "hi" })).pipe(Effect.map((parts) => Array.from(parts).filter((part) => part.type === "text-delta").map((part) => part.delta).join(""))),
    })
    expect(Exit.match(stream.result, { onFailure: () => "failed", onSuccess: (text) => text })).toBe("ok")
    expect(await droppedCount("anthropic:claude-fable-5-1", "prefix_binding_mismatch")).toBe(before + 3)
  })
})
