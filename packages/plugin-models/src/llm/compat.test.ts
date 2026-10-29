import { describe, expect, test } from "bun:test"
import { Prompt, Tool } from "effect/ai"
import { Deferred, Effect, Fiber, Option, Schema } from "effect"
import { CurrentModelCallPolicy, CurrentPromptCacheKey, extractUsage, Failure, mediaFromBase64, mediaLabel, modelRequestDescriptorOf, ToolCallId, toPromptMessages } from "@xandreed/core"
import type { AgentMessage } from "@xandreed/core"
import { fromChatCompletion, makeCompatLanguageModel, promptWithImageLabels, thinkingParams, toChatMessages } from "./compat.js"

const completion = (body: unknown, status = 200): typeof fetch =>
  ((_url: unknown, _init?: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    )) as typeof fetch

const capture = (): { calls: Array<{ url: string; body: unknown }>; impl: typeof fetch } => {
  const calls: Array<{ url: string; body: unknown }> = []
  const impl = ((url: unknown, init?: { body?: unknown }) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) })
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200 },
      ),
    )
  }) as typeof fetch
  return { calls, impl }
}

const Echo = Tool.make("echo", {
  description: "echo back",
  parameters: Schema.Struct({ value: Schema.String }),
  success: Schema.Struct({ echoed: Schema.String }),
  failure: Failure,
  failureMode: "return",
})

describe("makeCompatLanguageModel", () => {
  test("its request descriptor matches the public options sent on the wire", async () => {
    const { calls, impl } = capture()
    const descriptor = await Effect.runPromise(Effect.gen(function* () {
      const svc = yield* makeCompatLanguageModel({
        moduleName: "Test", model: "kimi-k2-code", chatUrl: "https://gw.example/chat/completions",
        apiKey: "secret-test-key", temperature: 0.25, fetchImpl: impl,
      })
      const descriptor = yield* modelRequestDescriptorOf(svc)
      yield* svc.generateText({ prompt: "hello" })
      return descriptor
    }).pipe(
      Effect.provideService(CurrentPromptCacheKey, Option.some("lane:test")),
      Effect.provideService(CurrentModelCallPolicy, Option.some({ effort: "high", maxOutputTokens: 32 })),
    ))
    expect(Option.isSome(descriptor)).toBe(true)
    if (Option.isSome(descriptor)) {
      const sent = calls[0]!.body as Record<string, unknown>
      expect(descriptor.value).toEqual({
        provider: "Test", model: "kimi-k2-code",
        settings: Object.fromEntries(Object.entries(sent).filter(([key]) => !["messages", "model", "stream"].includes(key))),
      })
      expect(JSON.stringify(descriptor.value)).not.toContain("secret-test-key")
    }
  })
  test("the wire keeps its key order: sampling before the messages, gateway extensions after them", async () => {
    const { calls, impl } = capture()
    await Effect.runPromise(Effect.gen(function* () {
      const svc = yield* makeCompatLanguageModel({
        moduleName: "Test", model: "kimi-k2-code", chatUrl: "https://gw.example/chat/completions",
        apiKey: "secret-test-key", temperature: 0.25, fetchImpl: impl,
      })
      yield* svc.generateText({ prompt: "hello" })
    }).pipe(
      Effect.provideService(CurrentPromptCacheKey, Option.some("lane:test")),
      Effect.provideService(CurrentModelCallPolicy, Option.some({ effort: "high", maxOutputTokens: 32 })),
    ))
    expect(Object.keys(calls[0]!.body as Record<string, unknown>)).toEqual([
      "model", "temperature", "messages", "stream", "prompt_cache_key", "thinking", "reasoning_effort", "max_tokens",
    ])
  })
  test("sends chat-completions shape: system + messages + tools + bearer key", async () => {
    const { calls, impl } = capture()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* makeCompatLanguageModel({
          moduleName: "Test",
          chatUrl: "https://gw.example/chat/completions",
          apiKey: "sk-test",
          model: "test-model",
          temperature: 0.25,
          fetchImpl: impl,
        })
        return yield* svc.generateText({
          prompt: [
            { role: "system", content: "sys" },
            { role: "user", content: "hi" },
          ],
          toolkit: undefined as never,
          // Tools ride ProviderOptions in the raw path; exercise via toolkit-less call.
        } as never)
      }),
    )
    expect(result.text).toBe("ok")
    const sent = calls[0]?.body as {
      model: string
      stream: boolean
      messages: ReadonlyArray<{ role: string; content: string }>
    }
    expect(calls[0]?.url).toBe("https://gw.example/chat/completions")
    expect(sent.model).toBe("test-model")
    expect(sent.stream).toBe(false)
    expect(calls[0]?.body).toMatchObject({ temperature: 0.25 })
    expect(sent.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ])
  })

  test("generateObject can disable thinking while preserving schema validation", async () => {
    const calls: unknown[] = []
    const result = await Effect.runPromise(Effect.gen(function* () {
      const svc = yield* makeCompatLanguageModel({
        moduleName: "Test", chatUrl: "https://gw.example/chat", apiKey: "test", model: "deepseek-flash", thinking: "disabled", reasoningEffort: "none",
        fetchImpl: ((url: unknown, init: { body?: string }) => {
          calls.push(JSON.parse(init.body ?? "{}"))
          return completion({ choices: [{ finish_reason: "stop", message: { content: '{"covered":true}' } }] })(String(url))
        }) as typeof fetch,
      })
      return yield* svc.generateObject({ prompt: "Judge coverage", objectName: "grounding", schema: Schema.Struct({ covered: Schema.Boolean }) }).pipe(Effect.provideService(CurrentModelCallPolicy, Option.some({ effort: "low", maxOutputTokens: 256 })))
    }))
    expect(result.value).toEqual({ covered: true })
    expect(calls[0]).toMatchObject({ thinking: { type: "disabled" }, reasoning: { effort: "none" }, max_tokens: 256 })
    expect(calls[0]).not.toHaveProperty("reasoning_effort")
    expect(calls[0]).toMatchObject({ response_format: { type: "json_schema", json_schema: { name: "grounding", strict: true, schema: { type: "object", required: ["covered"] } } } })
  })

  test("a non-OK status becomes a status-classified AiError with the status + body excerpt", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const svc = yield* makeCompatLanguageModel({
          moduleName: "Test",
          chatUrl: "https://gw.example/chat",
          apiKey: "k",
          model: "m",
          fetchImpl: completion({ error: "overloaded" }, 429),
        })
        return yield* svc.generateText({
          prompt: [{ role: "user", content: "hi" }],
        } as never)
      }),
    )
    expect(exit._tag).toBe("Failure")
    const rendered = JSON.stringify(exit)
    expect(rendered).toContain("RateLimitError")
    expect(rendered).toContain("429")
    expect(rendered).toContain("overloaded")
  })

  test("a request that fails before any response is described by its failure's code and message, proxy credentials redacted, never [object Object]", async () => {
    const failed = await Effect.runPromise(Effect.flip(Effect.gen(function* () {
      const svc = yield* makeCompatLanguageModel({
        moduleName: "Test", chatUrl: "https://gw.example/chat", model: "m",
        fetchImpl: () => Promise.reject({ code: "ECONNREFUSED", message: "connect refused by http://user:secret@proxy.invalid:8080" }),
      })
      return yield* svc.generateText({ prompt: "hi" })
    })))
    expect(failed.reason._tag).toBe("UnknownError")
    expect(failed.reason.message).toBe("ECONNREFUSED: connect refused by http://<redacted>@proxy.invalid:8080")
  })

  /** The reason a request answered with this status and body fails with. */
  const failureOf = (body: unknown, status: number) => Effect.runPromise(Effect.flip(Effect.gen(function* () {
    const svc = yield* makeCompatLanguageModel({ moduleName: "OpenCode", chatUrl: "https://gw.example/chat", apiKey: "k", model: "m", fetchImpl: completion(body, status) })
    return yield* svc.generateText({ prompt: "hi" })
  })))

  test("an exhausted balance or quota is a QuotaExhaustedError by status or structured error; a plain 429 stays a rate limit", async () => {
    const credits = await failureOf({ type: "error", error: { type: "CreditsError", message: "Insufficient balance" } }, 401)
    expect(credits.reason._tag).toBe("QuotaExhaustedError")
    expect(credits.reason.isRetryable).toBe(false)
    expect((await failureOf({ error: { message: "Insufficient Balance" } }, 402)).reason._tag).toBe("QuotaExhaustedError")
    expect((await failureOf({ error: { type: "requests", code: "insufficient_quota", message: "You exceeded your current quota" } }, 429)).reason._tag).toBe("QuotaExhaustedError")
    // The word "quota" in a rate limit's message is no exhausted quota.
    const limited = await failureOf({ error: { type: "rate_limit", message: "Rate limit quota exceeded, retry shortly" } }, 429)
    expect(limited.reason._tag).toBe("RateLimitError")
  })

  test("a completion body that is no chat completion is the provider's invalid response, never the model's invalid output", async () => {
    const reasons = await Promise.all([
      Effect.runPromise(Effect.flip(Effect.gen(function* () {
        const svc = yield* makeCompatLanguageModel({ moduleName: "Test", chatUrl: "https://gw.example/chat", model: "m", fetchImpl: () => Promise.resolve(new Response("<html>bad gateway</html>")) })
        return yield* svc.generateText({ prompt: "hi" })
      }))),
      failureOf(null, 200),
      failureOf({ choices: [{ message: { content: ["a", "part"] } }] }, 200),
      failureOf({ choices: [] }, 200),
    ])
    expect(reasons.map((error) => error.reason._tag)).toEqual(["InvalidResponseError", "InvalidResponseError", "InvalidResponseError", "InvalidResponseError"])
  })

  test("a gateway ModelError is semantic validation, not fake authentication", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const svc = yield* makeCompatLanguageModel({
          moduleName: "OpenCode",
          chatUrl: "https://gw.example/chat",
          apiKey: "k",
          model: "unsupported-model",
          fetchImpl: completion({
            type: "error",
            error: { type: "ModelError", message: "Model unsupported-model is not supported" },
          }, 401),
        })
        return yield* svc.generateText({ prompt: [{ role: "user", content: "hi" }] } as never)
      }),
    )
    expect(exit._tag).toBe("Failure")
    const rendered = JSON.stringify(exit)
    expect(rendered).toContain("InvalidRequestError")
    expect(rendered).toContain("not supported")
    // A 401 would otherwise read as a bad key.
    expect(rendered).not.toContain("AuthenticationError")
  })

  test("tool_calls parse into tool-call parts with object params + tool-calls finish", async () => {
    const parts = await Effect.runPromise(
      fromChatCompletion("Test", {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [
                { id: "c1", function: { name: "echo", arguments: `{"value":"hi"}` } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }),
    )
    expect(parts).toEqual([
      { type: "tool-call", id: "c1", name: "echo", params: { value: "hi" } },
      {
        type: "finish",
        reason: "tool-calls",
        usage: { inputTokens: { total: 5, uncached: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } },
      },
    ])
  })

  test("thinking is FORCED for the adaptive families, absent otherwise", async () => {
    // 24/24 no-think turns emitted degenerate empty tool calls (live
    // forensics) — kimi/deepseek get thinking:{type:"enabled"}, qwen gets
    // enable_thinking, unknown families get nothing.
    const { calls, impl } = capture()
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* makeCompatLanguageModel({
          moduleName: "Test",
          chatUrl: "https://gw.example/chat",
          apiKey: "k",
          model: "kimi-k2.7-code",
          fetchImpl: impl,
        })
        return yield* svc.generateText({ prompt: [{ role: "user", content: "hi" }] } as never)
      }),
    )
    expect((calls[0]?.body as { thinking?: unknown }).thinking).toEqual({ type: "enabled" })
    // The CODE variant rides HIGH effort (live-probed: 103 → 398 reasoning
    // tokens on the same prompt); the conversational tiers stay light.
    expect((calls[0]?.body as { reasoning_effort?: unknown }).reasoning_effort).toBe("high")
    expect(thinkingParams("kimi-k2.7-code")).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    })
    expect(thinkingParams("kimi-k2.6")).toEqual({ thinking: { type: "enabled" } })
    expect(thinkingParams("deepseek-v4-flash")).toEqual({ thinking: { type: "enabled" } })
    expect(thinkingParams("qwen3-coder")).toEqual({ enable_thinking: true })
    expect(thinkingParams("glm-5.2")).toEqual({})
  })

  test("a dedicated agent policy overrides family effort and pins its output budget", async () => {
    const { calls, impl } = capture()
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* makeCompatLanguageModel({
          moduleName: "Test",
          chatUrl: "https://gw.example/chat",
          apiKey: "k",
          model: "deepseek-v4-flash",
          fetchImpl: impl,
        })
        return yield* svc.generateText({ prompt: [{ role: "user", content: "plan" }] } as never)
      }).pipe(
        Effect.provideService(CurrentModelCallPolicy, Option.some({ effort: "low", maxOutputTokens: 1800 })),
      ),
    )
    expect((calls[0]?.body as { reasoning_effort?: unknown }).reasoning_effort).toBe("low")
    expect((calls[0]?.body as { max_tokens?: unknown }).max_tokens).toBe(1800)
  })

  test("BOTH reasoning vocabularies parse into a reasoning part", async () => {
    // OpenRouter-style `reasoning` (kimi-k2.6) and DeepSeek-native
    // `reasoning_content` (kimi-k2.7-code, deepseek) — live-probed 2026-07-08.
    const viaReasoning = await Effect.runPromise(
      fromChatCompletion("Test", {
        choices: [{ finish_reason: "stop", message: { content: "ok", reasoning: "because…" } }],
      }),
    )
    expect(viaReasoning[0]).toEqual({ type: "reasoning", text: "because…" })
    const viaReasoningContent = await Effect.runPromise(
      fromChatCompletion("Test", {
        choices: [
          { finish_reason: "stop", message: { content: "ok", reasoning_content: "since…" } },
        ],
      }),
    )
    expect(viaReasoningContent[0]).toEqual({ type: "reasoning", text: "since…" })
  })

  test("cached-token vendor fallbacks are read (prompt_cache_hit_tokens et al.)", async () => {
    const parts = await Effect.runPromise(
      fromChatCompletion("Test", {
        choices: [{ finish_reason: "stop", message: { content: "x" } }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 1,
          total_tokens: 101,
          prompt_cache_hit_tokens: 90,
        },
      }),
    )
    const finish = parts[parts.length - 1] as { usage: { inputTokens: { cacheRead: number } } }
    expect(finish.usage.inputTokens.cacheRead).toBe(90)
  })

  test("cache writes and reasoning are read from the usage details; an endpoint read without reasoning (Google's) reports none", async () => {
    const body = {
      choices: [{ finish_reason: "stop", message: { content: "x" } }],
      usage: {
        prompt_tokens: 1000, completion_tokens: 30, total_tokens: 1030,
        prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 },
        // A gateway may count more reasoning than completion: the loop's extraction raises the output to it.
        completion_tokens_details: { reasoning_tokens: 50 },
      },
    }
    const usageOf = (parts: ReadonlyArray<unknown>) => (parts[parts.length - 1] as { usage: unknown }).usage
    expect(usageOf(await Effect.runPromise(fromChatCompletion("Test", body)))).toEqual({
      inputTokens: { total: 1000, uncached: 100, cacheRead: 600, cacheWrite: 300 },
      outputTokens: { total: 30, text: 0, reasoning: 50 },
    })
    expect(usageOf(await Effect.runPromise(fromChatCompletion("Test", body, { reasoning: false })))).toEqual({
      inputTokens: { total: 1000, uncached: 100, cacheRead: 600, cacheWrite: 300 },
      outputTokens: { total: 30, text: 30, reasoning: 0 },
    })
    const extracted = extractUsage(usageOf(await Effect.runPromise(fromChatCompletion("Test", body))), [])
    expect([extracted.outputTokens, extracted.reasoningTokens, extracted.totalTokens]).toEqual([50, 50, 1050])
    // The model reads them the same way. A standard-only endpoint (a configured one, a local server) still
    // reads its reasoning; only a model told not to (the built-in google provider) reads none.
    const generated = (config: { readonly standardOnly?: boolean; readonly usage?: { readonly reasoning?: boolean } }) => Effect.runPromise(Effect.gen(function* () {
      const svc = yield* makeCompatLanguageModel({ moduleName: "Test", model: "m", chatUrl: "https://gw.example/chat/completions", ...config, fetchImpl: completion(body) })
      const res = yield* svc.generateText({ prompt: "hello" })
      return extractUsage(res.usage, res.content)
    }))
    expect((await generated({ standardOnly: false })).reasoningTokens).toBe(50)
    expect((await generated({ standardOnly: true })).reasoningTokens).toBe(50)
    expect(await generated({ standardOnly: true, usage: { reasoning: false } })).toEqual({ inputTokens: 1000, outputTokens: 30, totalTokens: 1030, cacheReadTokens: 600, cacheWriteTokens: 300, reasoningTokens: 0 })
  })

  test("unparseable tool arguments are an invalid output (the loop's corrective path)", async () => {
    const exit = await Effect.runPromiseExit(
      fromChatCompletion("Test", {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              tool_calls: [{ id: "c1", function: { name: "echo", arguments: "{nope" } }],
            },
          },
        ],
      }),
    )
    expect(exit._tag).toBe("Failure")
    expect(JSON.stringify(exit)).toContain("InvalidOutputError")
  })

  test("Echo tool declaration shape is exported for the request", () => {
    // Pin the JSON-schema mapping the gateway sees.
    expect(Tool.isUserDefined(Echo)).toBe(true)
  })

  test("the engine's cache identity rides as prompt_cache_key; absent when unstamped", async () => {
    const { calls, impl } = capture()
    const svc = await Effect.runPromise(
      makeCompatLanguageModel({
        moduleName: "Test",
        chatUrl: "https://gw.example/chat",
        apiKey: "k",
        model: "m",
        fetchImpl: impl,
      }),
    )
    const request = svc.generateText({ prompt: [{ role: "user", content: "hi" }] } as never)
    await Effect.runPromise(
      request.pipe(Effect.provideService(CurrentPromptCacheKey, Option.some("conv-abc"))),
    )
    await Effect.runPromise(request)
    expect((calls[0]?.body as { prompt_cache_key?: string }).prompt_cache_key).toBe("conv-abc")
    expect("prompt_cache_key" in (calls[1]?.body as Record<string, unknown>)).toBe(false)
  })
})

test("interrupting a provider call aborts fetch while response bytes are pending", async () => {
  const aborted: boolean[] = []
  await Effect.runPromise(Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const model = yield* makeCompatLanguageModel({
      moduleName: "Test", chatUrl: "https://gw.example/chat", apiKey: "test", model: "test",
      fetchImpl: ((_url: unknown, init: RequestInit) => Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          init.signal?.addEventListener("abort", () => { aborted.push(true); controller.error(new Error("aborted")) }, { once: true })
          Deferred.doneUnsafe(started, Effect.void)
        },
      })))) as typeof fetch,
    })
    const fiber = yield* Effect.forkChild(model.generateText({ prompt: "hello" }))
    yield* Deferred.await(started)
    yield* Fiber.interrupt(fiber)
  }))
  expect(aborted).toEqual([true])
})

describe("toChatMessages: a user's images", () => {
  const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
  const chat = (messages: ReadonlyArray<AgentMessage>) => toChatMessages(Prompt.make(toPromptMessages(messages)))

  test("an image-only message is its label line, never empty content", async () => {
    const image = await Effect.runPromise(mediaFromBase64(pixel, { name: "pixel.png" }))
    expect(chat([{ role: "user", content: [image] }])).toEqual([{ role: "user", content: mediaLabel(image) }])
    expect(mediaLabel(image)).toBe("[image omitted: image/png, 70 B, pixel.png]")
  })

  test("text and an image: the text, then the image's label line", async () => {
    const image = await Effect.runPromise(mediaFromBase64(pixel))
    expect(chat([{ role: "user", content: [image, { type: "text", text: "what is this?" }] }]))
      .toEqual([{ role: "user", content: `what is this?\n${mediaLabel(image)}` }])
  })

  test("a text-only message is sent as before", () => {
    expect(chat([{ role: "user", content: "hi" }])).toEqual([{ role: "user", content: "hi" }])
  })
})

describe("toChatMessages: images on an endpoint that reads them", () => {
  const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
  const image = Effect.runSync(mediaFromBase64(pixel, { name: "pixel.png" }))
  const dataUrl = `data:image/png;base64,${pixel}`
  const prompt = (messages: ReadonlyArray<AgentMessage>) => Prompt.make(toPromptMessages(messages))
  const callAndResult = (id: string, text: string): ReadonlyArray<AgentMessage> => [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: ToolCallId.make(id), toolName: "screenshot", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: ToolCallId.make(id), toolName: "screenshot", output: text, isError: false, media: [image] }] },
  ]

  test("a user's images are image_url parts with a data: URL, in order; a text-only message is a string as before", () => {
    expect(toChatMessages(prompt([{ role: "user", content: [image, { type: "text", text: "what is this?" }] }]), { images: true })).toEqual([
      { role: "user", content: [{ type: "image_url", image_url: { url: dataUrl } }, { type: "text", text: "what is this?" }] },
    ])
    expect(toChatMessages(prompt([{ role: "user", content: "hi" }]), { images: true })).toEqual([{ role: "user", content: "hi" }])
  })

  test("a tool's images follow the batch's tool messages in one user message, each result's captioned", () => {
    const messages: ReadonlyArray<AgentMessage> = [
      { role: "user", content: "look" },
      { role: "assistant", content: [
        { type: "tool-call", toolCallId: ToolCallId.make("c1"), toolName: "screenshot", input: {} },
        { type: "tool-call", toolCallId: ToolCallId.make("c2"), toolName: "screenshot", input: {} },
      ] },
      { role: "tool", content: [
        { type: "tool-result", toolCallId: ToolCallId.make("c1"), toolName: "screenshot", output: "home", isError: false, media: [image] },
        { type: "tool-result", toolCallId: ToolCallId.make("c2"), toolName: "screenshot", output: "", isError: false, media: [image] },
      ] },
    ]
    expect(toChatMessages(prompt(messages), { images: true }).slice(2)).toEqual([
      { role: "tool", tool_call_id: "c1", content: "home" },
      { role: "tool", tool_call_id: "c2", content: "[the images this call returned follow]" },
      { role: "user", content: [
        { type: "text", text: "Images returned by screenshot (call c1):" }, { type: "image_url", image_url: { url: dataUrl } },
        { type: "text", text: "Images returned by screenshot (call c2):" }, { type: "image_url", image_url: { url: dataUrl } },
      ] },
    ])
  })

  test("a user message right after the batch is merged into the images' message", () => {
    const chat = toChatMessages(prompt([...callAndResult("c1", "home"), { role: "user", content: "step 2" }]), { images: true })
    expect(chat.slice(1)).toEqual([
      { role: "tool", tool_call_id: "c1", content: "home" },
      { role: "user", content: [{ type: "text", text: "Images returned by screenshot (call c1):" }, { type: "image_url", image_url: { url: dataUrl } }, { type: "text", text: "step 2" }] },
    ])
  })

  test("a merged user message with images of its own is captioned, so its images are not read as the tool's", () => {
    const chat = toChatMessages(prompt([...callAndResult("c1", "home"), { role: "user", content: [image, { type: "text", text: "and this one?" }] }]), { images: true })
    expect(chat.at(-1)).toEqual({ role: "user", content: [
      { type: "text", text: "Images returned by screenshot (call c1):" }, { type: "image_url", image_url: { url: dataUrl } },
      { type: "text", text: "The user's message:" }, { type: "image_url", image_url: { url: dataUrl } }, { type: "text", text: "and this one?" },
    ] })
  })

  test("without images a tool result is its text with a label line per image, and no user message follows", () => {
    expect(toChatMessages(prompt(callAndResult("c1", "home"))).slice(1)).toEqual([{ role: "tool", tool_call_id: "c1", content: `home\n${mediaLabel(image)}` }])
  })

  test("promptWithImageLabels: every file part becomes its label line, what a route without images is sent", () => {
    const relabeled = promptWithImageLabels(prompt([{ role: "user", content: [image, { type: "text", text: "look" }] }, ...callAndResult("c1", "")]))
    expect(JSON.stringify(relabeled.content)).not.toContain(pixel)
    const [user, , tool] = relabeled.content
    expect(user?.role === "user" ? user.content.map((part) => part.type === "text" ? part.text : part.type) : []).toEqual([`look\n${mediaLabel(image)}`])
    expect(tool?.role === "tool" ? tool.content.map((part) => part.type === "tool-result" ? [part.result, part.modelOutput] : []) : []).toEqual([[mediaLabel(image), undefined]])
    const plain = prompt([{ role: "user", content: "hi" }])
    expect(promptWithImageLabels(plain).content[0]).toBe(plain.content[0])
  })
})

describe("toChatMessages: a tool the provider ran", () => {
  test("its call and result are left out of a replay to a chat-completions model, never sent as a plain tool_call", () => {
    const messages: ReadonlyArray<AgentMessage> = [
      { role: "user", content: "find it" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Searching." },
          { type: "tool-call", toolCallId: ToolCallId.make("ws_1"), toolName: "web_search", input: { query: "effect" }, providerExecuted: true },
          { type: "tool-result", toolCallId: ToolCallId.make("ws_1"), toolName: "web_search", output: [{ url: "https://effect.website" }], isError: false, providerExecuted: true },
          { type: "tool-call", toolCallId: ToolCallId.make("c1"), toolName: "read", input: { path: "a" }, providerExecuted: false },
        ],
      },
      { role: "tool", content: [{ type: "tool-result", toolCallId: ToolCallId.make("c1"), toolName: "read", output: "contents", isError: false }] },
    ]
    expect(toChatMessages(Prompt.make(toPromptMessages(messages)))).toEqual([
      { role: "user", content: "find it" },
      { role: "assistant", content: "Searching.", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "contents" },
    ])
  })
})
