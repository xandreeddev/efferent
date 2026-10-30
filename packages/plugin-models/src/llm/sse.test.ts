import { describe, expect, test } from "bun:test"
import { Effect, Match, Option, Stream } from "effect"
import { ToolCallId } from "@xandreed/core"
import { fromChatCompletion, makeCompatLanguageModel } from "./compat.js"
import { finishReasonFromWire, sseStreamParts } from "./sse.js"

/**
 * The SSE state machine's spec: exact part sequences from canned wires,
 * chunk-boundary torture, the DONE-independent flush, error taxonomy, and
 * round-trip parity with the non-streaming parser. One live Bun.serve test
 * proves parts arrive INCREMENTALLY (not buffered to the end).
 */

const enc = new TextEncoder()

const bodyFromChunks = (chunks: ReadonlyArray<Uint8Array>): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(chunk))
      controller.close()
    },
  })

const wire = (...events: ReadonlyArray<string>): string =>
  events.map((event) => `data: ${event}\n\n`).join("")

const collect = (
  text: string,
  chunker: (bytes: Uint8Array) => ReadonlyArray<Uint8Array> = (bytes) => [bytes],
): Promise<ReadonlyArray<unknown>> =>
  Effect.runPromise(
    Stream.runCollect(
      sseStreamParts({ moduleName: "Test", body: bodyFromChunks(chunker(enc.encode(text))) }),
    ),
  )

const zeroUsage = { inputTokens: { total: 0, uncached: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } }

describe("sseStreamParts", () => {
  test("text deltas: start → deltas → end → finish with the final-chunk usage", async () => {
    const parts = await collect(
      wire(
        `{"choices":[{"delta":{"content":"Hel"}}]}`,
        `{"choices":[{"delta":{"content":"lo"}}]}`,
        `{"choices":[{"delta":{},"finish_reason":"stop"}]}`,
        `{"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}`,
        `[DONE]`,
      ),
    )
    expect(parts).toEqual([
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "Hel" },
      { type: "text-delta", id: "text-1", delta: "lo" },
      { type: "text-end", id: "text-1" },
      {
        type: "finish",
        reason: "stop",
        usage: { inputTokens: { total: 5, uncached: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } },
      },
    ])
  })

  test("BOTH reasoning vocabularies stream; reasoning closes when text starts", async () => {
    const viaReasoningContent = await collect(
      wire(
        `{"choices":[{"delta":{"reasoning_content":"thin"}}]}`,
        `{"choices":[{"delta":{"reasoning_content":"king"}}]}`,
        `{"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}`,
        `[DONE]`,
      ),
    )
    expect(viaReasoningContent).toEqual([
      { type: "reasoning-start", id: "reasoning-1" },
      { type: "reasoning-delta", id: "reasoning-1", delta: "thin" },
      { type: "reasoning-delta", id: "reasoning-1", delta: "king" },
      { type: "reasoning-end", id: "reasoning-1" },
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "answer" },
      { type: "text-end", id: "text-1" },
      { type: "finish", reason: "stop", usage: zeroUsage },
    ])
    const viaReasoning = await collect(
      wire(`{"choices":[{"delta":{"reasoning":"hmm"}}]}`, `[DONE]`),
    )
    expect(viaReasoning.slice(0, 2)).toEqual([
      { type: "reasoning-start", id: "reasoning-1" },
      { type: "reasoning-delta", id: "reasoning-1", delta: "hmm" },
    ])
  })

  test("tool-call fragments merge by index; id/name on first, arguments concatenate", async () => {
    const parts = await collect(
      wire(
        `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"echo","arguments":"{\\"va"}}]}}]}`,
        `{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"lue\\":\\"hi\\"}"}}]}}]}`,
        `{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
        `[DONE]`,
      ),
    )
    expect(parts).toEqual([
      { type: "tool-call", id: "c1", name: "echo", params: { value: "hi" } },
      { type: "finish", reason: "tool-calls", usage: zeroUsage },
    ])
  })

  test("two interleaved tool calls keep their own argument buffers", async () => {
    const parts = await collect(
      wire(
        `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"first","arguments":"{\\"n\\":"}}]}}]}`,
        `{"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"second","arguments":"{}"}}]}}]}`,
        `{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}`,
        `[DONE]`,
      ),
    )
    expect(parts).toEqual([
      { type: "tool-call", id: "a", name: "first", params: { n: 1 } },
      { type: "tool-call", id: "b", name: "second", params: {} },
      { type: "finish", reason: "tool-calls", usage: zeroUsage },
    ])
  })

  test("a stream cut at the output limit keeps its tool calls and finishes on length", async () => {
    const parts = await collect(
      wire(
        `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"echo","arguments":"{\\"value\\":\\"hi\\"}"}}]}}]}`,
        `{"choices":[{"delta":{},"finish_reason":"length"}]}`,
        `[DONE]`,
      ),
    )
    expect(parts).toEqual([
      { type: "tool-call", id: "c1", name: "echo", params: { value: "hi" } },
      { type: "finish", reason: "length", usage: zeroUsage },
    ])
  })

  /** Every word the wire's finish reason is read from, and how it reads: once with tool calls, once without. */
  const finishWords: ReadonlyArray<string | null | undefined> = [
    "stop", "tool_calls", "function_call", "tool_use", "tool_call", "end_turn", "stop_sequence", "eos",
    "length", "max_tokens", "content_filter", "error", "insufficient_system_resource",
    "STOP", "MAX_TOKENS", "recitation", null, undefined, "",
  ]

  test("the streamed finish reason is the wire's, read case-insensitively; a cut stays a cut when the stream holds tool calls", async () => {
    const callChunk = `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"echo","arguments":"{}"}}]}}]}`
    // An absent reason is a bare end of stream: no finish chunk and no [DONE].
    const finishOf = async (finishReason: string | null | undefined, toolCalls: boolean) => {
      const parts = await collect(
        wire(
          `{"choices":[{"delta":{"content":"ok"}}]}`,
          ...(toolCalls ? [callChunk] : []),
          ...(finishReason === undefined ? [] : [`{"choices":[{"delta":{},"finish_reason":${JSON.stringify(finishReason)}}]}`, `[DONE]`]),
        ),
      )
      return parts.flatMap((part) => {
        const p = part as { type: string; reason?: string }
        return p.type === "finish" ? [p.reason] : []
      })
    }
    const cases = finishWords.flatMap((word) => [[word, true] as const, [word, false] as const])
    const seen = await Effect.runPromise(
      Effect.forEach(cases, ([finishReason, toolCalls]) => Effect.tryPromise(() => finishOf(finishReason, toolCalls)), { concurrency: 1 }),
    )
    expect(cases.map(([finishReason, toolCalls], at) => [String(finishReason), toolCalls, seen[at]])).toEqual([
      ["stop", true, ["tool-calls"]],
      ["stop", false, ["stop"]],
      ["tool_calls", true, ["tool-calls"]],
      ["tool_calls", false, ["stop"]],
      ["function_call", true, ["tool-calls"]],
      ["function_call", false, ["stop"]],
      ["tool_use", true, ["tool-calls"]],
      ["tool_use", false, ["stop"]],
      ["tool_call", true, ["tool-calls"]],
      ["tool_call", false, ["stop"]],
      ["end_turn", true, ["tool-calls"]],
      ["end_turn", false, ["stop"]],
      ["stop_sequence", true, ["tool-calls"]],
      ["stop_sequence", false, ["stop"]],
      ["eos", true, ["tool-calls"]],
      ["eos", false, ["stop"]],
      ["length", true, ["length"]],
      ["length", false, ["length"]],
      ["max_tokens", true, ["length"]],
      ["max_tokens", false, ["length"]],
      ["content_filter", true, ["content-filter"]],
      ["content_filter", false, ["content-filter"]],
      ["error", true, ["error"]],
      ["error", false, ["error"]],
      ["insufficient_system_resource", true, ["error"]],
      ["insufficient_system_resource", false, ["error"]],
      ["STOP", true, ["tool-calls"]],
      ["STOP", false, ["stop"]],
      ["MAX_TOKENS", true, ["length"]],
      ["MAX_TOKENS", false, ["length"]],
      ["recitation", true, ["other"]],
      ["recitation", false, ["other"]],
      ["null", true, ["tool-calls"]],
      ["null", false, ["stop"]],
      ["undefined", true, ["tool-calls"]],
      ["undefined", false, ["stop"]],
      ["", true, ["tool-calls"]],
      ["", false, ["stop"]],
    ])
  })

  test("finishReasonFromWire: a cut is never coerced; a settling word or none settles on the tool calls", () => {
    const raws = finishWords.map((word) => Option.fromNullishOr(word))
    expect(raws.map((raw) => [finishReasonFromWire(raw, true), finishReasonFromWire(raw, false)])).toEqual([
      ["tool-calls", "stop"],
      ["tool-calls", "stop"],
      ["tool-calls", "stop"],
      ["tool-calls", "stop"],
      ["tool-calls", "stop"],
      ["tool-calls", "stop"],
      ["tool-calls", "stop"],
      ["tool-calls", "stop"],
      ["length", "length"],
      ["length", "length"],
      ["content-filter", "content-filter"],
      ["error", "error"],
      ["error", "error"],
      ["tool-calls", "stop"],
      ["length", "length"],
      ["other", "other"],
      ["tool-calls", "stop"],
      ["tool-calls", "stop"],
      ["tool-calls", "stop"],
    ])
  })

  test("a blank finish reason on a later chunk keeps the reason an earlier chunk named", async () => {
    const parts = await collect(
      wire(
        `{"choices":[{"delta":{"content":"x"},"finish_reason":"length"}]}`,
        `{"choices":[{"delta":{},"finish_reason":""}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`,
        `[DONE]`,
      ),
    )
    expect(parts.slice(-1)).toEqual([
      {
        type: "finish",
        reason: "length",
        usage: { inputTokens: { total: 1, uncached: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
      },
    ])
  })

  test("a stream cut in the middle of a call's arguments keeps the call with params {} and ends on the cut", async () => {
    const cutAt = (finishReason: string) =>
      collect(
        wire(
          `{"choices":[{"delta":{"content":"Writing both files."}}]}`,
          `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"write","arguments":"{\\"path\\":\\"a.txt\\",\\"content\\":\\"done\\"}"}}]}}]}`,
          `{"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c2","function":{"name":"write","arguments":"{\\"path\\":\\"b.txt\\","}}]}}]}`,
          `{"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"\\"content\\":\\"half of the"}}]}}]}`,
          `{"choices":[{"delta":{},"finish_reason":${JSON.stringify(finishReason)}}]}`,
          `[DONE]`,
        ),
      )
    const seen = await Effect.runPromise(
      Effect.forEach(["length", "content_filter", "error", "recitation"], (reason) => Effect.tryPromise(() => cutAt(reason)), { concurrency: 1 }),
    )
    const cut = (reason: string) => [
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "Writing both files." },
      { type: "text-end", id: "text-1" },
      { type: "tool-call", id: "c1", name: "write", params: { path: "a.txt", content: "done" } },
      { type: "tool-call", id: "c2", name: "write", params: {} },
      { type: "finish", reason, usage: zeroUsage },
    ]
    expect(seen).toEqual([cut("length"), cut("content-filter"), cut("error"), cut("other")])
  })

  test("a missing [DONE] still flushes: open chunks close, the finish lands", async () => {
    const parts = await collect(
      wire(
        `{"choices":[{"delta":{"reasoning_content":"only thinking"}}]}`,
        `{"choices":[{"delta":{},"finish_reason":"stop"}]}`,
      ),
    )
    expect(parts).toEqual([
      { type: "reasoning-start", id: "reasoning-1" },
      { type: "reasoning-delta", id: "reasoning-1", delta: "only thinking" },
      { type: "reasoning-end", id: "reasoning-1" },
      { type: "finish", reason: "stop", usage: zeroUsage },
    ])
  })

  test("a server [DONE] plus the injected sentinel flush exactly once", async () => {
    const parts = await collect(
      wire(`{"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}`, `[DONE]`),
    )
    expect(parts.filter((part) => (part as { type: string }).type === "finish")).toHaveLength(1)
  })

  test("empty deltas emit NOTHING (content-part identity)", async () => {
    const parts = await collect(
      wire(
        `{"choices":[{"delta":{"content":""}}]}`,
        `{"choices":[{"delta":{"reasoning_content":""}}]}`,
        `{"choices":[{"delta":{"content":null},"finish_reason":"stop"}]}`,
        `[DONE]`,
      ),
    )
    expect(parts).toEqual([{ type: "finish", reason: "stop", usage: zeroUsage }])
  })

  test("chunk-boundary torture: mid-line and mid-UTF-8 splits reassemble", async () => {
    const text = wire(
      `{"choices":[{"delta":{"content":"café ☕ 日本"}}]}`,
      `{"choices":[{"delta":{},"finish_reason":"stop"}]}`,
      `[DONE]`,
    )
    // 3-byte slices guarantee splits inside multi-byte characters AND lines.
    const parts = await collect(text, (bytes) =>
      Array.from({ length: Math.ceil(bytes.length / 3) }, (_, at) =>
        bytes.slice(at * 3, at * 3 + 3),
      ),
    )
    expect(parts).toEqual([
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "café ☕ 日本" },
      { type: "text-end", id: "text-1" },
      { type: "finish", reason: "stop", usage: zeroUsage },
    ])
  })

  test("cached-token vendor fallbacks fold from the streamed usage", async () => {
    const parts = await collect(
      wire(
        `{"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}`,
        `{"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":1,"total_tokens":101,"prompt_cache_hit_tokens":90}}`,
        `[DONE]`,
      ),
    )
    const finish = parts[parts.length - 1] as { usage: { inputTokens: unknown } }
    expect(finish.usage.inputTokens).toEqual({ total: 100, uncached: 10, cacheRead: 90, cacheWrite: 0 })
  })

  test("cache writes and reasoning fold from the streamed usage's details", async () => {
    const usage = `{"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":60,"total_tokens":1060,` +
      `"prompt_tokens_details":{"cached_tokens":700,"cache_write_tokens":200},"completion_tokens_details":{"reasoning_tokens":45}}}`
    const parts = await collect(wire(`{"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}`, usage, `[DONE]`))
    expect((parts[parts.length - 1] as { usage: unknown }).usage).toEqual({
      inputTokens: { total: 1000, uncached: 100, cacheRead: 700, cacheWrite: 200 },
      outputTokens: { total: 60, text: 15, reasoning: 45 },
    })
  })

  test("an endpoint read without reasoning (Google's) reports none", async () => {
    const text = wire(
      `{"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}`,
      `{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4,"completion_tokens_details":{"reasoning_tokens":40}}}`,
      `[DONE]`,
    )
    const parts = await Effect.runPromise(Stream.runCollect(sseStreamParts({ moduleName: "Test", body: bodyFromChunks([enc.encode(text)]), usage: { reasoning: false } })))
    expect((parts[parts.length - 1] as { usage: unknown }).usage).toEqual({
      inputTokens: { total: 10, uncached: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 4, text: 4, reasoning: 0 },
    })
  })

  /** The reason a stream of these wire lines fails with. */
  const failureOf = (text: string) =>
    Effect.runPromise(Effect.flip(Stream.runCollect(sseStreamParts({ moduleName: "Test", body: bodyFromChunks([enc.encode(text)]) }))))

  test("a data line that is no chunk (not JSON, null, a field of the wrong type) is the provider's invalid response, not the model's output", async () => {
    const lines = ["data: {nope\n\n", wire("null"), wire(`{"choices":[{"delta":{"tool_calls":{"index":0}}}]}`), wire(`{"choices":[{"delta":{"content":["a","part"]}}]}`)]
    const failures = await Promise.all(lines.map(failureOf))
    expect(failures.map((error) => error.reason._tag)).toEqual(["InvalidResponseError", "InvalidResponseError", "InvalidResponseError", "InvalidResponseError"])
    expect(failures[0]!.message).toContain("{nope")
  })

  test("an error chunk naming an exhausted quota is a QuotaExhaustedError; any other is retried as before", async () => {
    const quota = await failureOf(wire(`{"error":{"type":"CreditsError","message":"Insufficient balance"}}`))
    expect(quota.reason._tag).toBe("QuotaExhaustedError")
    const other = await failureOf(wire(`{"error":{"message":"quota of requests per minute reached"}}`))
    expect(other.reason._tag).toBe("UnknownError")
  })

  test("a body stream that fails is described by its failure's code and message, proxy credentials redacted, never [object Object]", async () => {
    const failed = await Effect.runPromise(Effect.flip(Stream.runCollect(sseStreamParts({
      moduleName: "Test",
      body: new ReadableStream({ start: (controller) => controller.error({ code: "ECONNRESET", message: "reset by http://user:secret@proxy.invalid:8080" }) }),
    }))))
    expect(failed.reason._tag).toBe("UnknownError")
    expect(failed.reason.message).toBe("the response body stream failed: ECONNRESET: reset by http://<redacted>@proxy.invalid:8080")
  })

  test("an error chunk mid-stream fails the stream", async () => {
    const exit = await Effect.runPromiseExit(
      Stream.runCollect(
        sseStreamParts({
          moduleName: "Test",
          body: bodyFromChunks([enc.encode(wire(`{"error":{"message":"overloaded"}}`))]),
        }),
      ),
    )
    expect(exit._tag).toBe("Failure")
    expect(JSON.stringify(exit)).toContain("overloaded")
  })

  test("unparseable accumulated tool arguments are an invalid output at flush", async () => {
    const exit = await Effect.runPromiseExit(
      Stream.runCollect(
        sseStreamParts({
          moduleName: "Test",
          body: bodyFromChunks([
            enc.encode(
              wire(
                `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"echo","arguments":"{broken"}}]}}]}`,
                `[DONE]`,
              ),
            ),
          ]),
        }),
      ),
    )
    expect(exit._tag).toBe("Failure")
    expect(JSON.stringify(exit)).toContain("InvalidOutputError")
  })

  test("unparseable arguments in a stream that ended on its own still fail with the model's invalid output", async () => {
    const call = `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"echo","arguments":"{\\"value\\":\\"h"}}]}}]}`
    const endings = ["stop", "tool_calls", "end_turn"].map((reason) => wire(call, `{"choices":[{"delta":{},"finish_reason":"${reason}"}]}`, `[DONE]`))
    const failures = await Promise.all([...endings, wire(call)].map(failureOf))
    const invalid = { _tag: "InvalidOutputError", description: "tool call echo carried unparseable JSON arguments" }
    expect(failures.map((failure) => [failure.module, failure.method])).toEqual([
      ["Test", "streamText"],
      ["Test", "streamText"],
      ["Test", "streamText"],
      ["Test", "streamText"],
    ])
    failures.forEach((failure) => expect(failure.reason).toMatchObject(invalid))
  })

  test("round-trip parity: folded stream parts ≡ fromChatCompletion on the same completion", async () => {
    const streamed = await collect(
      wire(
        `{"choices":[{"delta":{"reasoning_content":"beca"}}]}`,
        `{"choices":[{"delta":{"reasoning_content":"use…"}}]}`,
        `{"choices":[{"delta":{"content":"o"}}]}`,
        `{"choices":[{"delta":{"content":"k"}}]}`,
        `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"echo","arguments":"{\\"value\\":\\"hi\\"}"}}]}}]}`,
        `{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
        `{"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}`,
        `[DONE]`,
      ),
    )
    const folded = streamed.reduce(
      (acc: { reasoning: string; text: string; rest: ReadonlyArray<unknown> }, part) => {
        const p = part as { type: string; delta?: string }
        return Match.value(p.type).pipe(
          Match.when("reasoning-delta", () => ({ ...acc, reasoning: acc.reasoning + (p.delta ?? "") })),
          Match.when("text-delta", () => ({ ...acc, text: acc.text + (p.delta ?? "") })),
          Match.whenOr("tool-call", "finish", () => ({ ...acc, rest: [...acc.rest, part] })),
          // The other parts (starts, ends, metadata) carry nothing this test compares.
          Match.orElse(() => acc),
        )
      },
      { reasoning: "", text: "", rest: [] },
    )
    const settled = await Effect.runPromise(
      fromChatCompletion("Test", {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "ok",
              reasoning_content: "because…",
              tool_calls: [{ id: ToolCallId.make("c1"), function: { name: "echo", arguments: `{"value":"hi"}` } }],
            },
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }),
    )
    expect([
      { type: "reasoning", text: folded.reasoning },
      { type: "text", text: folded.text },
      ...folded.rest,
    ]).toEqual(settled as never)
  })
})

describe("compat streamText", () => {
  const sseResponse = (text: string): typeof fetch =>
    ((_url: unknown, _init?: unknown) =>
      Promise.resolve(
        new Response(bodyFromChunks([enc.encode(text)]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      )) as typeof fetch

  test("sends stream:true + include_usage and yields schema-valid decoded parts", async () => {
    const calls: Array<{ body: unknown }> = []
    const impl = ((url: unknown, init?: { body?: unknown }) => {
      calls.push({ body: JSON.parse(String(init?.body ?? "{}")) })
      return (sseResponse(
        wire(
          `{"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}`,
          `{"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`,
          `[DONE]`,
        ),
      ) as (u: unknown, i?: unknown) => Promise<Response>)(url, init)
    }) as typeof fetch
    const parts = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* makeCompatLanguageModel({
          moduleName: "Test",
          chatUrl: "https://gw.example/chat/completions",
          apiKey: "k",
          model: "test-model",
          fetchImpl: impl,
        })
        return yield* Stream.runCollect(
          svc.streamText({ prompt: [{ role: "user", content: "hi" }] } as never),
        )
      }).pipe(Effect.scoped),
    )
    const sent = calls[0]?.body as { stream: boolean; stream_options: unknown }
    expect(sent.stream).toBe(true)
    expect(sent.stream_options).toEqual({ include_usage: true })
    const types = parts.map((part) => (part as { type: string }).type)
    expect(types).toEqual(["text-start", "text-delta", "text-end", "finish"])
    const delta = parts[1] as { delta: string }
    expect(delta.delta).toBe("hi")
  })

  test("a non-OK status is a status-classified AiError BEFORE any part (the retry boundary)", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const svc = yield* makeCompatLanguageModel({
          moduleName: "Test",
          chatUrl: "https://gw.example/chat",
          apiKey: "k",
          model: "m",
          fetchImpl: ((_u: unknown, _i?: unknown) =>
            Promise.resolve(new Response(`{"error":"overloaded"}`, { status: 429 }))) as typeof fetch,
        })
        return yield* Stream.runCollect(
          svc.streamText({ prompt: [{ role: "user", content: "hi" }] } as never),
        )
      }).pipe(Effect.scoped),
    )
    expect(exit._tag).toBe("Failure")
    const rendered = JSON.stringify(exit)
    expect(rendered).toContain("RateLimitError")
    expect(rendered).toContain("429")
  })

  test("live dribble: the first delta arrives while the server still holds the tail", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(
                enc.encode(`data: {"choices":[{"delta":{"content":"first"}}]}\n\n`),
              )
              await new Promise((resolve) => setTimeout(resolve, 300))
              controller.enqueue(
                enc.encode(
                  `data: {"choices":[{"delta":{"content":" second"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`,
                ),
              )
              controller.close()
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    })
    const stamps = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* makeCompatLanguageModel({
          moduleName: "Test",
          chatUrl: `http://localhost:${server.port}/chat`,
          apiKey: "k",
          model: "m",
        })
        return yield* Stream.runFold(
          svc.streamText({ prompt: [{ role: "user", content: "hi" }] } as never),
          (): ReadonlyArray<{ readonly type: string; readonly at: number }> => [],
          (acc, part) => [
            ...acc,
            { type: (part as { type: string }).type, at: performance.now() },
          ],
        )
      }).pipe(Effect.scoped),
    )
    server.stop(true)
    const firstDelta = stamps.find((stamp) => stamp.type === "text-delta")
    const finish = stamps[stamps.length - 1]
    expect(firstDelta).toBeDefined()
    expect(finish?.type).toBe("finish")
    // The server held the tail 300ms — a buffered (non-incremental) client
    // would observe near-zero spread between the first delta and the finish.
    expect((finish?.at ?? 0) - (firstDelta?.at ?? 0)).toBeGreaterThan(150)
  })
})

test("SSE keeps missing tool-call ids empty for the loop to assign, and preserves provider ids", async () => {
  const parts = await collect(wire(
    JSON.stringify({ choices: [{ delta: { tool_calls: [
      { index: 0, function: { name: "echo", arguments: "{}" } },
      { index: 1, id: "provider:second", function: { name: "echo", arguments: "{}" } },
      { index: 2, id: "", function: { name: "echo", arguments: "{}" } },
    ] } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    "[DONE]",
  ))
  expect(parts).toEqual([
    { type: "tool-call", id: "", name: "echo", params: {} },
    { type: "tool-call", id: "provider:second", name: "echo", params: {} },
    { type: "tool-call", id: "", name: "echo", params: {} },
    { type: "finish", reason: "tool-calls", usage: zeroUsage },
  ])
})
