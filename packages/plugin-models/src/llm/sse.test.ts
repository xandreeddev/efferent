import { describe, expect, test } from "bun:test"
import { Chunk, Effect, Stream } from "effect"
import { fromChatCompletion, makeCompatLanguageModel } from "./compat.js"
import { sseStreamParts } from "./sse.js"

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
    ).pipe(Effect.map(Chunk.toReadonlyArray)),
  )

const zeroUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0 }

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
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7, cachedInputTokens: 0 },
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
    const finish = parts[parts.length - 1] as { usage: { cachedInputTokens: number } }
    expect(finish.usage.cachedInputTokens).toBe(90)
  })

  test("a non-JSON data line is a MalformedOutput", async () => {
    const exit = await Effect.runPromiseExit(
      Stream.runCollect(
        sseStreamParts({
          moduleName: "Test",
          body: bodyFromChunks([enc.encode("data: {nope\n\n")]),
        }),
      ),
    )
    expect(exit._tag).toBe("Failure")
    expect(JSON.stringify(exit)).toContain("MalformedOutput")
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

  test("unparseable accumulated tool arguments are a MalformedOutput at flush", async () => {
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
    expect(JSON.stringify(exit)).toContain("MalformedOutput")
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
        if (p.type === "reasoning-delta") {
          return { ...acc, reasoning: acc.reasoning + (p.delta ?? "") }
        }
        if (p.type === "text-delta") return { ...acc, text: acc.text + (p.delta ?? "") }
        if (p.type === "tool-call" || p.type === "finish") {
          return { ...acc, rest: [...acc.rest, part] }
        }
        return acc
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
              tool_calls: [{ id: "c1", function: { name: "echo", arguments: `{"value":"hi"}` } }],
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
        ).pipe(Effect.map(Chunk.toReadonlyArray))
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

  test("a non-OK status is an HttpResponseError BEFORE any part (the retry boundary)", async () => {
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
    expect(rendered).toContain("HttpResponseError")
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
          [] as ReadonlyArray<{ readonly type: string; readonly at: number }>,
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
