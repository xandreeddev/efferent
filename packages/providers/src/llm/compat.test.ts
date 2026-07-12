import { describe, expect, test } from "bun:test"
import { Tool } from "@effect/ai"
import { Effect, Option, Schema } from "effect"
import { CurrentModelCallPolicy, CurrentPromptCacheKey, Failure } from "@xandreed/engine"
import { fromChatCompletion, makeCompatLanguageModel, thinkingParams } from "./compat.js"

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
  parameters: { value: Schema.String },
  success: Schema.Struct({ echoed: Schema.String }),
  failure: Failure,
  failureMode: "return",
})

describe("makeCompatLanguageModel", () => {
  test("sends chat-completions shape: system + messages + tools + bearer key", async () => {
    const { calls, impl } = capture()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* makeCompatLanguageModel({
          moduleName: "Test",
          chatUrl: "https://gw.example/chat/completions",
          apiKey: "sk-test",
          model: "test-model",
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
    expect(sent.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ])
  })

  test("a non-OK status becomes HttpResponseError with the status + body excerpt", async () => {
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
    expect(rendered).toContain("HttpResponseError")
    expect(rendered).toContain("429")
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
    expect(rendered).toContain("MalformedInput")
    expect(rendered).toContain("not supported")
    expect(rendered).not.toContain("HttpResponseError")
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
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8, cachedInputTokens: 0 },
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
        Effect.locally(CurrentModelCallPolicy, Option.some({ effort: "low", maxOutputTokens: 1800 })),
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
    const finish = parts[parts.length - 1] as { usage: { cachedInputTokens: number } }
    expect(finish.usage.cachedInputTokens).toBe(90)
  })

  test("unparseable tool arguments are a MalformedOutput (the loop's corrective path)", async () => {
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
    expect(JSON.stringify(exit)).toContain("MalformedOutput")
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
      request.pipe(Effect.locally(CurrentPromptCacheKey, Option.some("conv-abc"))),
    )
    await Effect.runPromise(request)
    expect((calls[0]?.body as { prompt_cache_key?: string }).prompt_cache_key).toBe("conv-abc")
    expect("prompt_cache_key" in (calls[1]?.body as Record<string, unknown>)).toBe(false)
  })
})
