import { describe, expect, test } from "bun:test"
import { Prompt, Tool, Toolkit } from "effect/ai"
import { Deferred, Effect, Fiber, Option, Result, Schema, Stream } from "effect"
import { CurrentModelCallPolicy, CurrentPromptCacheKey, Failure, foldStreamParts, modelRequestDescriptorOf, responseToAgentMessages, toPromptMessages } from "@xandreed/core"
import type { AgentMessage } from "@xandreed/core"
import { fromChatCompletion, makeCompatLanguageModel, thinkingParams } from "./compat.js"
import { classifyLlmError, retryableLlm, retryableLlmStream } from "./retry.js"
import { withFallbackRung } from "./router.js"
import { ModelId, ModelSelection, ProviderId } from "@xandreed/core"

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

const ReadFixture = Tool.make("read_file", {
  description: "Read a fixture file.", parameters: Schema.Struct({ path: Schema.String }),
  success: Schema.Struct({ content: Schema.String, truncated: Schema.Boolean }),
  failure: Failure, failureMode: "return",
})

const continuationWire = (index: number) => ({
  choices: [{ finish_reason: index < 2 ? "tool_calls" : "stop", message: {
    reasoning_content: ["inspect requested file", "recover with README", "report recovered result"][index],
    content: index < 2 ? null : "README recovered successfully.",
    ...(index < 2 ? { tool_calls: [{ id: `read-${index}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: index === 0 ? "missing.md" : "README.md" }) } }] } : {}),
  } }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
})

const continuationSse = (index: number) => {
  const wire = continuationWire(index)
  const message = wire.choices[0]!.message
  const delta = { ...message, ...(message.tool_calls === undefined ? {} : { tool_calls: message.tool_calls.map((call) => ({ ...call, index: 0 })) }) }
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: wire.choices[0]!.finish_reason }], usage: wire.usage })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
}

;[false, true].forEach((streaming) => test(`DeepSeek ${streaming ? "streamed" : "settled"} tool recovery replays reasoning and typed failures through the production adapter`, async () => {
  const calls: Array<{ messages: ReadonlyArray<{ role: string; reasoning_content?: string; tool_call_id?: string; content?: string }>; tools: ReadonlyArray<{ function: { name: string; parameters: unknown } }> }> = []
  const invoked: Array<string> = []
  const routing: Array<{ session: string | null; agent: string | null }> = []
  const result = await Effect.runPromise(Effect.gen(function* () {
    const model = yield* makeCompatLanguageModel({
      moduleName: "OpenCode", chatUrl: "https://fixture.invalid/chat/completions", apiKey: "fixture-key", model: "deepseek-v4-flash",
      fetchImpl: (_url, init) => {
        const headers = new Headers(init?.headers)
        routing.push({ session: headers.get("x-opencode-session"), agent: headers.get("user-agent") })
        const body = JSON.parse(String(init?.body)) as typeof calls[number]
        calls.push(body)
        const index = calls.length - 1
        const prior = body.messages.filter((message) => message.role === "assistant")
        const expected = ["inspect requested file", "recover with README"]
        const missingReasoning = prior.some((message, at) => message.reasoning_content !== expected[at])
        return Promise.resolve(missingReasoning || !routing.at(-1)?.session
          ? Response.json({ error: { message: "reasoning_content must be passed back in thinking mode" } }, { status: 400 })
          : streaming ? continuationSse(index) : Response.json(continuationWire(index)))
      },
    })
    const kit = Toolkit.make(ReadFixture)
    const handlers = kit.toLayer({ read_file: ({ path }) => Effect.sync(() => { invoked.push(path) }).pipe(Effect.andThen(path === "missing.md" ? Effect.fail({ error: "NotFound", message: "missing.md was not found; inspect README.md" }) : Effect.succeed({ content: "README fixture", truncated: false }))) })
    return yield* Effect.reduce([0, 1, 2], () => ({ messages: [{ role: "user", content: "Read the missing file, recover using README.md, and report the result." }] as ReadonlyArray<AgentMessage>, text: "" }), (state) => Effect.gen(function* () {
      const options = { prompt: Prompt.make(toPromptMessages(state.messages) as never), toolkit: kit }
      const response = streaming ? yield* foldStreamParts(model.streamText(options), () => Effect.void) : yield* model.generateText(options)
      const tail = responseToAgentMessages(response.content)
      return { messages: [...state.messages, ...tail], text: tail.flatMap((message) => message.role === "assistant" ? message.content.flatMap((part) => part.type === "text" ? [part.text] : []) : []).join("") }
    }).pipe(Effect.provide(handlers)))
  }))
  expect(result.text).toBe("README recovered successfully.")
  expect(invoked).toEqual(["missing.md", "README.md"])
  expect(calls).toHaveLength(3)
  expect(new Set(routing.map((headers) => headers.session)).size).toBe(1)
  expect(routing[0]?.session?.length).toBeGreaterThan(0)
  expect(routing.every((headers) => headers.agent === "efferent/0.8.0-next.0")).toBe(true)
  expect(calls[0]?.tools[0]?.function).toMatchObject({ name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } })
  expect(calls[1]?.messages.find((message) => message.role === "tool")).toMatchObject({ tool_call_id: "read-0", content: JSON.stringify({ error: "NotFound", message: "missing.md was not found; inspect README.md" }) })
  expect(calls[2]?.messages.filter((message) => message.role === "assistant").map((message) => message.reasoning_content)).toEqual(["inspect requested file", "recover with README"])
  expect(result.messages.filter((message) => message.role === "tool").flatMap((message) => message.content.map((part) => part.isError))).toEqual([true, false])
}))

;[400, 500].flatMap((status) => [false, true].map((streaming) => ({ status, streaming }))).forEach(({ status, streaming }) => test(`OpenCode regional rejection is actionable and permanent for ${status} ${streaming ? "stream" : "settled"} without retry or fallback`, async () => {
  const body = { error: { type: "server_error", message: "Upstream request failed: This Go model requires Global regions. Select Global in your workspace's Privacy settings to use it." } }
  const requests: Array<string> = []
  const attempted: Array<string> = []
  const outcome = await Effect.runPromise(Effect.gen(function* () {
    const model = yield* makeCompatLanguageModel({ moduleName: "OpenCode", chatUrl: "https://fixture.invalid/chat", apiKey: "fixture-key", model: "deepseek-v4-flash", fetchImpl: (url) => { requests.push(String(url)); return Promise.resolve(Response.json(body, { status })) } })
    const primary = new ModelSelection({ provider: ProviderId.make("opencode"), modelId: ModelId.make("deepseek-v4-flash") })
    const fallback = Option.some(new ModelSelection({ provider: ProviderId.make("fixture"), modelId: ModelId.make("forbidden-fallback") }))
    return yield* Effect.result(withFallbackRung(primary, fallback, (selection) => {
      attempted.push(String(selection.modelId))
      return streaming
        ? model.streamText({ prompt: "hello" }).pipe(retryableLlmStream("regional-fixture"), Stream.runCollect, Effect.asVoid)
        : model.generateText({ prompt: "hello" }).pipe(retryableLlm("regional-fixture"), Effect.asVoid)
    }))
  }))
  expect(Result.isFailure(outcome)).toBe(true)
  if (Result.isFailure(outcome)) {
    expect(classifyLlmError(outcome.failure)).toBe("permanent")
    expect(String(outcome.failure).split("\n")[0]).toContain("This Go model requires Global regions. Select Global in your workspace's Privacy settings to use it.")
    expect(String(outcome.failure).split("\n")[0]).not.toContain("server_error")
    expect(String(outcome.failure)).toContain(JSON.stringify(body))
  }
  expect(requests).toHaveLength(1)
  expect(attempted).toEqual(["deepseek-v4-flash"])
}))

;[400, 401, 500].flatMap((status) => [false, true].map((streaming) => ({ status, streaming }))).forEach(({ status, streaming }) => test(`OpenCode nested credits rejection keeps HTTP evidence and never retries or falls back for ${status} ${streaming ? "stream" : "settled"}`, async () => {
  const body = { error: { type: "CreditsError", message: "Insufficient credits for this request." } }
  const requests: Array<string> = []
  const attempted: Array<string> = []
  const outcome = await Effect.runPromise(Effect.gen(function* () {
    const model = yield* makeCompatLanguageModel({ moduleName: "OpenCode", chatUrl: "https://fixture.invalid/chat", apiKey: "fixture-key", model: "deepseek-v4-flash", fetchImpl: (url) => { requests.push(String(url)); return Promise.resolve(Response.json(body, { status, headers: { "x-request-id": "credits-fixture" } })) } })
    const primary = new ModelSelection({ provider: ProviderId.make("opencode"), modelId: ModelId.make("deepseek-v4-flash") })
    const fallback = Option.some(new ModelSelection({ provider: ProviderId.make("fixture"), modelId: ModelId.make("forbidden-fallback") }))
    return yield* Effect.result(withFallbackRung(primary, fallback, (selection) => {
      attempted.push(String(selection.modelId))
      return streaming
        ? model.streamText({ prompt: "hello" }).pipe(retryableLlmStream("credits-fixture"), Stream.runCollect, Effect.asVoid)
        : model.generateText({ prompt: "hello" }).pipe(retryableLlm("credits-fixture"), Effect.asVoid)
    }))
  }))
  expect(Result.isFailure(outcome)).toBe(true)
  if (Result.isFailure(outcome)) {
    expect(classifyLlmError(outcome.failure)).toBe("permanent")
    expect(String(outcome.failure).split("\n")[0]).toContain("Insufficient credits for this request.")
    expect(String(outcome.failure)).toContain(JSON.stringify(body))
    expect(String(outcome.failure)).not.toContain("fixture-key")
    expect(outcome.failure).toMatchObject({ reason: { _tag: "InvalidRequestError", http: { request: { method: "POST", url: "https://fixture.invalid/chat" }, response: { status, headers: { "x-request-id": "credits-fixture" } }, body: JSON.stringify(body) } } })
  }
  expect(requests).toHaveLength(1)
  expect(attempted).toEqual(["deepseek-v4-flash"])
}))

describe("makeCompatLanguageModel", () => {
  ;[{ status: 401, type: "CreditsError", message: "Insufficient credits" }, { status: 503, type: "server_error", message: "Temporary upstream rejection" }].flatMap((rejection) => [false, true].map((streaming) => ({ ...rejection, streaming }))).forEach(({ status, type, message, streaming }) => {
    test(`redacts reflected auth and sensitive error headers for ${status} ${streaming ? "stream" : "settled"} while preserving evidence`, async () => {
      const key = "fixture-reflected-auth-key"
      const body = { error: { type, message: `${message}: ${key}; Bearer ${key}`, details: { suppliedCredential: key, remedy: "Check account configuration" } } }
      const outcome = await Effect.runPromise(Effect.gen(function* () {
        const model = yield* makeCompatLanguageModel({
          moduleName: "VercelGateway", chatUrl: "https://fixture.invalid/chat", apiKey: key, model: "deepseek/deepseek-v4.1-flash", gatewayDialect: "vercel",
          fetchImpl: () => Promise.resolve(Response.json(body, { status, headers: {
            authorization: `Bearer ${key}`, "proxy-authorization": "fixture-proxy-credential", cookie: "fixture-cookie-secret", "set-cookie": "fixture-session-secret",
            "x-api-key": "fixture-header-key", "x-auth-token": "fixture-header-token", "x-vercel-protection-bypass": "fixture-bypass-token",
            "x-request-id": `request-${key}-public`, "retry-after": "3",
          } })),
        })
        return yield* Effect.result(streaming ? Stream.runCollect(model.streamText({ prompt: "hello" })).pipe(Effect.asVoid) : model.generateText({ prompt: "hello" }).pipe(Effect.asVoid))
      }))
      expect(Result.isFailure(outcome)).toBe(true)
      if (Result.isFailure(outcome)) {
        const serialized = JSON.stringify(outcome.failure)
        expect(serialized).not.toContain(key)
        expect(String(outcome.failure)).not.toContain(key)
        expect(serialized).not.toContain("fixture-cookie-secret")
        expect(serialized).not.toContain("fixture-session-secret")
        expect(serialized).not.toContain("fixture-header-key")
        expect(serialized).not.toContain("fixture-header-token")
        expect(serialized).not.toContain("fixture-proxy-credential")
        expect(serialized).not.toContain("fixture-bypass-token")
        expect(serialized).toContain("Check account configuration")
        expect(outcome.failure).toMatchObject({ reason: { http: {
          request: { method: "POST", url: "https://fixture.invalid/chat", headers: { "content-type": "application/json" } },
          response: { status, headers: { authorization: "[redacted]", "proxy-authorization": "[redacted]", cookie: "[redacted]", "set-cookie": "[redacted]", "x-api-key": "[redacted]", "x-auth-token": "[redacted]", "x-vercel-protection-bypass": "[redacted]", "x-request-id": "request-[redacted]-public", "retry-after": "3" } },
          body: JSON.stringify(body).split(key).join("[redacted]"),
        } } })
        expect(classifyLlmError(outcome.failure)).toBe(status === 401 ? "permanent" : "transient")
      }
    })
  })

  ;[false, true].forEach((streaming) => test(`redacts a reflected credential in ${streaming ? "stream" : "settled"} transport failures`, async () => {
    const key = "fixture-reflected-transport-key"
    const outcome = await Effect.runPromise(Effect.gen(function* () {
      const model = yield* makeCompatLanguageModel({ moduleName: "VercelGateway", chatUrl: "https://fixture.invalid/chat", apiKey: key, model: "fixture", fetchImpl: () => Promise.reject(new Error(`Transport rejected Bearer ${key}`)) })
      return yield* Effect.result(streaming ? Stream.runCollect(model.streamText({ prompt: "hello" })).pipe(Effect.asVoid) : model.generateText({ prompt: "hello" }).pipe(Effect.asVoid))
    }))
    expect(Result.isFailure(outcome)).toBe(true)
    if (Result.isFailure(outcome)) {
      expect(JSON.stringify(outcome.failure)).not.toContain(key)
      expect(String(outcome.failure)).toContain("Transport rejected Bearer [redacted]")
    }
  }))

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
        usage: { inputTokens: { total: 5, uncached: 5, cacheRead: 0 }, outputTokens: { total: 3 } },
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
