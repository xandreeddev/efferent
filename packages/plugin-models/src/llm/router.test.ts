import { describe, expect, test } from "bun:test"
import { AiError, LanguageModel } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import { Effect, Layer, Metric, Option, Redacted, Ref, Stream, Tracer } from "effect"
import { AuthStore, EngineSettings, ModelSelection, modelRequestDescriptorOf, parseModelSelection, resolveModelRequest, SettingsStore } from "@xandreed/core"
import { CurrentModelEndpoints } from "../ports/model-endpoints.port.js"
import { generateWith, LanguageModelLive, stampResponse, tapStreamTelemetry, withFallbackRung } from "./router.js"

const finish = {
  type: "finish",
  reason: "tool-calls",
  usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
}

const content = [
  { type: "text", text: "listing…" },
  { type: "tool-call", id: "c1", name: "ls", params: { path: "." } },
  finish,
]

describe("stampResponse", () => {
  test("stamps the resolved model onto the finish part's metadata", () => {
    const stamped = stampResponse({ content }, "opencode:kimi-k2.6")
    const finishPart = stamped.content.find(
      (p) => (p as { type?: string }).type === "finish",
    ) as { metadata?: { router?: { model?: string } } }
    expect(finishPart.metadata?.router?.model).toBe("opencode:kimi-k2.6")
  })

  test("REGRESSION: the class getters survive — a plain spread killed the loop", () => {
    // finishReason/text/usage are prototype getters on GenerateTextResponse;
    // `{...res}` strips them, finishReason reads undefined, and the engine
    // loop sees every tool-calling turn as "completed" (one tool call, then
    // the run silently dies). stampResponse must return a REAL instance.
    const stamped = stampResponse(
      new LanguageModel.GenerateTextResponse(content as never),
      "opencode:kimi-k2.6",
    )
    expect(stamped).toBeInstanceOf(LanguageModel.GenerateTextResponse)
    expect(stamped.finishReason).toBe("tool-calls")
    expect(stamped.text).toBe("listing…")
    expect(stamped.usage.inputTokens.total).toBe(10)
  })
})

/** The SAME metric identities the router registers — description + attributes
 *  are part of the registry key, so this pins the metric contract too. */
const counterValue = (name: string, description: string, tags: ReadonlyArray<[string, string]>) =>
  Effect.runPromise(
    Metric.value(
      Metric.withAttributes(Metric.counter(name, { description, incremental: true }), Object.fromEntries(tags)),
    ),
  ).then((state) => state.count)

const streamedParts = [
  { type: "reasoning-start", id: "reasoning-1" },
  { type: "reasoning-delta", id: "reasoning-1", delta: "because…" },
  { type: "reasoning-end", id: "reasoning-1" },
  { type: "text-start", id: "text-1" },
  { type: "text-delta", id: "text-1", delta: "listing…" },
  { type: "text-end", id: "text-1" },
  { type: "tool-call", id: "c1", name: "ls", params: { path: "." } },
  {
    type: "finish",
    reason: "tool-calls",
    usage: { inputTokens: { total: 10, uncached: 3, cacheRead: 4, cacheWrite: 3 }, outputTokens: { total: 5, text: 3, reasoning: 2 } },
  },
]

describe("tapStreamTelemetry", () => {
  test("parts pass through unchanged; the finish part moves the SAME token counters generateWith moves", async () => {
    const label = "test:stream-parity"
    const collected = await Effect.runPromise(
      Stream.runCollect(
        tapStreamTelemetry(label)(Stream.fromIterable(streamedParts)),
      ),
    )
    expect(collected).toEqual(streamedParts)
    expect(
      await counterValue(
        "llm.usage.input_tokens",
        "prompt tokens consumed by routed LLM calls",
        [["llm.model", label]],
      ),
    ).toBe(10)
    expect(
      await counterValue(
        "llm.usage.output_tokens",
        "completion tokens produced by routed LLM calls",
        [["llm.model", label]],
      ),
    ).toBe(5)
    const shares = await Promise.all([
      counterValue("llm.usage.cache_read_tokens", "prompt tokens of routed LLM calls read from the provider's prompt cache", [["llm.model", label]]),
      counterValue("llm.usage.cache_write_tokens", "prompt tokens of routed LLM calls written to the provider's prompt cache", [["llm.model", label]]),
      counterValue("llm.usage.reasoning_tokens", "completion tokens of routed LLM calls spent on reasoning", [["llm.model", label]]),
    ])
    expect(shares).toEqual([4, 3, 2])
    expect(
      await counterValue(
        "llm.requests",
        "routed LLM calls by final outcome (after retries)",
        [
          ["llm.model", label],
          ["outcome", "ok"],
        ],
      ),
    ).toBe(1)
  })

  test("a failing stream counts outcome=error, not ok", async () => {
    const label = "test:stream-error"
    const exit = await Effect.runPromiseExit(
      Stream.runCollect(
        tapStreamTelemetry(label)(
          Stream.fromIterable(streamedParts.slice(0, 2)).pipe(
            Stream.concat(Stream.fail({ _tag: "HttpResponseError" })),
          ),
        ),
      ),
    )
    expect(exit._tag).toBe("Failure")
    expect(
      await counterValue(
        "llm.requests",
        "routed LLM calls by final outcome (after retries)",
        [
          ["llm.model", label],
          ["outcome", "error"],
        ],
      ),
    ).toBe(1)
    expect(
      await counterValue(
        "llm.requests",
        "routed LLM calls by final outcome (after retries)",
        [
          ["llm.model", label],
          ["outcome", "ok"],
        ],
      ),
    ).toBe(0)
  })
})

/** A tracer keeping every span it starts, to read their attributes once they ended. */
const capturingTracer = (spans: Array<Tracer.NativeSpan>) => Tracer.make({
  span: (options) => {
    const span = new Tracer.NativeSpan(options)
    spans.push(span)
    return span
  },
})

describe("generateWith", () => {
  test("a call's usage moves every token counter and lands on its providers.generate span", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: () => Response.json({
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        usage: {
          prompt_tokens: 1000, completion_tokens: 60, total_tokens: 1060,
          prompt_tokens_details: { cached_tokens: 700, cache_write_tokens: 200 },
          completion_tokens_details: { reasoning_tokens: 40 },
        },
      }),
    })
    // A local credential: a standard-only route that still reads the reasoning.
    const auth = Layer.succeed(AuthStore, AuthStore.of({
      all: Effect.succeed(new Map()),
      get: () => Effect.succeed(Option.some({ type: "local" as const, baseUrl: `http://127.0.0.1:${server.port}/v1` })),
      resolveKey: () => Effect.succeed(Option.none()),
      set: () => Effect.void,
      remove: () => Effect.void,
    }))
    const label = "usage-local:generate-parity"
    const spans: Array<Tracer.NativeSpan> = []
    await Effect.runPromise(Effect.fromOption(parseModelSelection(label)).pipe(
      Effect.flatMap((selection) => generateWith(selection, { prompt: "hi" })),
      Effect.withTracer(capturingTracer(spans)),
      Effect.provide(Layer.merge(auth, FetchHttpClient.layer)),
    )).finally(() => server.stop(true))
    const counters = await Promise.all([
      counterValue("llm.usage.input_tokens", "prompt tokens consumed by routed LLM calls", [["llm.model", label]]),
      counterValue("llm.usage.output_tokens", "completion tokens produced by routed LLM calls", [["llm.model", label]]),
      counterValue("llm.usage.cache_read_tokens", "prompt tokens of routed LLM calls read from the provider's prompt cache", [["llm.model", label]]),
      counterValue("llm.usage.cache_write_tokens", "prompt tokens of routed LLM calls written to the provider's prompt cache", [["llm.model", label]]),
      counterValue("llm.usage.reasoning_tokens", "completion tokens of routed LLM calls spent on reasoning", [["llm.model", label]]),
    ])
    expect(counters).toEqual([1000, 60, 700, 200, 40])
    const span = spans.find((found) => found.name === "providers.generate")
    expect([
      "llm.usage.input_tokens", "llm.usage.output_tokens", "llm.usage.cache_read_tokens", "llm.usage.cache_write_tokens", "llm.usage.reasoning_tokens",
    ].map((key) => span?.attributes.get(key))).toEqual([1000, 60, 700, 200, 40])
  })
})

describe("an endpoint with its own key", () => {
  test("is called with that key and never reads the AuthStore, an empty one sends none; one without a key reads it", async () => {
    const seen: Array<string | null> = []
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: (request) => {
        seen.push(request.headers.get("authorization"))
        return Response.json({ choices: [{ finish_reason: "stop", message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
      },
    })
    const url = `http://127.0.0.1:${server.port}/v1`
    const reads = Ref.makeUnsafe<ReadonlyArray<string>>([])
    const auth = Layer.succeed(AuthStore, AuthStore.of({
      all: Effect.die("the AuthStore was read"),
      get: (provider) => Ref.update(reads, (all) => [...all, `get ${provider}`]).pipe(Effect.as(Option.none())),
      resolveKey: (provider) => Ref.update(reads, (all) => [...all, `resolveKey ${provider}`]).pipe(Effect.as(Option.some(Redacted.make("stored-key")))),
      set: () => Effect.die("the AuthStore was written"),
      remove: () => Effect.die("the AuthStore was written"),
    }))
    const endpoints = {
      plain: { url, apiKey: "plain-key" },
      redacted: { url, apiKey: Redacted.make("redacted-key") },
      empty: { url, apiKey: "" },
      stored: { url },
    }
    await Effect.runPromise(Effect.forEach(["plain:m", "redacted:m", "empty:m", "stored:m"], (label) => Effect.fromOption(parseModelSelection(label)).pipe(
      Effect.flatMap((selection) => generateWith(selection, { prompt: "hi" })),
    )).pipe(
      Effect.provideService(CurrentModelEndpoints, endpoints),
      Effect.provide(Layer.merge(auth, FetchHttpClient.layer)),
    )).finally(() => server.stop(true))
    expect(seen).toEqual(["Bearer plain-key", "Bearer redacted-key", null, "Bearer stored-key"])
    expect(Ref.getUnsafe(reads)).toEqual(["get stored", "resolveKey stored"])
  })
})

describe("withFallbackRung", () => {
  const sel = (raw: string): ModelSelection =>
    Option.getOrThrow(parseModelSelection(raw))
  const primary = sel("opencode:kimi-k2.6")
  const fallback = Option.some(sel("google:gemini-3.5-flash"))
  const request = { method: "POST" as const, url: "https://gw.example/chat", urlParams: [], headers: {} }
  const statusError = (status: number) =>
    AiError.make({
      module: "Test",
      method: "generateText",
      reason: AiError.reasonFromHttpStatus({ status, http: { request, response: { status, headers: {} } } }),
    })
  const transient = statusError(503)
  const permanent = statusError(401)

  const scripted = (outcomes: Record<string, Effect.Effect<string, unknown>>) => {
    const calls: Array<{ readonly model: string; readonly isFallback: boolean }> = []
    const call = (selection: ModelSelection, isFallback: boolean) => {
      const key = `${selection.provider}:${selection.modelId}`
      calls.push({ model: key, isFallback })
      return outcomes[key] ?? Effect.fail("unscripted")
    }
    return { call, calls }
  }

  test("a TRANSIENT primary failure runs the fallback once, labeled", async () => {
    const { call, calls } = scripted({
      "opencode:kimi-k2.6": Effect.fail(transient),
      "google:gemini-3.5-flash": Effect.succeed("saved"),
    })
    const out = await Effect.runPromise(
      withFallbackRung(primary, fallback, call) as Effect.Effect<string>,
    )
    expect(out).toBe("saved")
    expect(calls).toEqual([
      { model: "opencode:kimi-k2.6", isFallback: false },
      { model: "google:gemini-3.5-flash", isFallback: true },
    ])
  })

  test("a PERMANENT failure never falls back — a different model can't fix a bad request", async () => {
    const { call, calls } = scripted({ "opencode:kimi-k2.6": Effect.fail(permanent) })
    const exit = await Effect.runPromiseExit(withFallbackRung(primary, fallback, call))
    expect(exit._tag).toBe("Failure")
    expect(calls).toHaveLength(1)
  })

  test("no fallback configured, or fallback === primary → the error passes through", async () => {
    const { call, calls } = scripted({ "opencode:kimi-k2.6": Effect.fail(transient) })
    const none = await Effect.runPromiseExit(withFallbackRung(primary, Option.none(), call))
    expect(none._tag).toBe("Failure")
    const same = await Effect.runPromiseExit(
      withFallbackRung(primary, Option.some(primary), call),
    )
    expect(same._tag).toBe("Failure")
    expect(calls).toHaveLength(2)
  })

  test("a healthy primary never touches the fallback", async () => {
    const { call, calls } = scripted({ "opencode:kimi-k2.6": Effect.succeed("fine") })
    const out = await Effect.runPromise(
      withFallbackRung(primary, fallback, call) as Effect.Effect<string>,
    )
    expect(out).toBe("fine")
    expect(calls).toEqual([{ model: "opencode:kimi-k2.6", isFallback: false }])
  })
})

describe("LanguageModelLive's step resolution", () => {
  test("a step reads the selection once: its description and its call keep it while the settings change", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const loads = yield* Ref.make(0)
      const selected = yield* Ref.make("opencode:glm-5.2")
      const settings = Layer.succeed(SettingsStore, SettingsStore.of({
        load: Ref.update(loads, (count) => count + 1).pipe(Effect.andThen(Ref.get(selected)), Effect.map((model) => new EngineSettings({ model: Option.some(model) }))),
        setRole: () => Effect.void,
        set: () => Effect.void,
      }))
      const auth = Layer.succeed(AuthStore, AuthStore.of({
        all: Effect.succeed(new Map()),
        get: () => Effect.succeed(Option.none()),
        resolveKey: () => Effect.succeed(Option.none()),
        set: () => Effect.void,
        remove: () => Effect.void,
      }))
      const routed = yield* LanguageModel.LanguageModel.pipe(Effect.provide(LanguageModelLive.pipe(Layer.provide(Layer.merge(settings, auth)))))
      const step = yield* resolveModelRequest(routed)
      // Another terminal switches the model while the step is in flight.
      yield* Ref.set(selected, "google:gemini-3.5-flash")
      const planned = yield* modelRequestDescriptorOf(step)
      const dispatched = yield* modelRequestDescriptorOf(step)
      const called = yield* Effect.flip(step.generateText({ prompt: "hello" }))
      return { loads: yield* Ref.get(loads), planned, dispatched, called: String(called) }
    }))
    expect(result.loads).toBe(1)
    expect(Option.map(result.planned, (descriptor) => `${descriptor.provider}:${descriptor.model}`)).toEqual(Option.some("opencode:glm-5.2"))
    expect(result.dispatched).toEqual(result.planned)
    // The call asks for the step's provider (it has no credential here), not the newly selected one.
    expect(result.called).toContain("no credential for opencode")
  })
})
