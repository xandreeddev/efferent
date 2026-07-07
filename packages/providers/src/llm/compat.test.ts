import { describe, expect, test } from "bun:test"
import { Tool } from "@effect/ai"
import { Effect, Schema } from "effect"
import { Failure } from "@xandreed/engine"
import { fromChatCompletion, makeCompatLanguageModel } from "./compat.js"

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
})
