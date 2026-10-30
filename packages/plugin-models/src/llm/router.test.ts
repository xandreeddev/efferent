import { describe, expect, test } from "bun:test"
import { AiError, LanguageModel, Response as AiResponse, Tool, Toolkit } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import { Cause, ConfigProvider, Deferred, Duration, Effect, Exit, Fiber, Layer, Logger, Metric, Option, Redacted, Ref, References, Schema, Stream, Tracer } from "effect"
import { TestClock } from "effect/testing"
import { AuthError, AuthStore, CurrentModelCallPolicy, CurrentTraceContent, EngineSettings, ModelSelection, modelRequestDescriptorOf, parseModelSelection, resolveModelRequest, responseModelOf, SettingsStore } from "@xandreed/core"
import { CurrentModelEndpoints } from "../ports/model-endpoints.port.js"
import { makeCallBudget, retryableLlm } from "./retry.js"
import type { CallBudget } from "./retry.js"
import { generateWith, LanguageModelLive, LanguageModelSelectionLive, stampResponse, tapStreamTelemetry, withFallbackRung, withHandOff } from "./router.js"

const finish = AiResponse.makePart("finish", {
  reason: "tool-calls",
  usage: new AiResponse.Usage({ inputTokens: { total: 10 }, outputTokens: { total: 5 } }),
})

const content = [
  AiResponse.makePart("text", { text: "listing…" }),
  AiResponse.makePart("tool-call", { id: "c1", name: "ls", params: { path: "." }, providerExecuted: false }),
  finish,
]

describe("stampResponse", () => {
  test("stamps the resolved model onto the finish part under core's key", () => {
    const stamped = stampResponse({ content }, "opencode:kimi-k2.6")
    expect(Option.getOrNull(responseModelOf(stamped.content))).toBe("opencode:kimi-k2.6")
    expect(stamped.content.find((part) => part.type === "finish")?.metadata).toStrictEqual({ engine: { model: "opencode:kimi-k2.6" } })
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
  /** The rung within a budget: a fresh one, as a routed call makes it, unless one is given. */
  const rung = <A, E>(
    fb: Option.Option<ModelSelection>,
    call: (selection: ModelSelection, isFallback: boolean) => Effect.Effect<A, E>,
    budget: Effect.Effect<CallBudget> = makeCallBudget(),
  ) => Effect.flatMap(budget, (made) => withFallbackRung(primary, fb, call, made))

  test("a TRANSIENT primary failure runs the fallback once, labeled", async () => {
    const { call, calls } = scripted({
      "opencode:kimi-k2.6": Effect.fail(transient),
      "google:gemini-3.5-flash": Effect.succeed("saved"),
    })
    const out = await Effect.runPromise(
      rung(fallback, call) as Effect.Effect<string>,
    )
    expect(out).toBe("saved")
    expect(calls).toEqual([
      { model: "opencode:kimi-k2.6", isFallback: false },
      { model: "google:gemini-3.5-flash", isFallback: true },
    ])
  })

  test("a PERMANENT failure never falls back — a different model can't fix a bad request", async () => {
    const { call, calls } = scripted({ "opencode:kimi-k2.6": Effect.fail(permanent) })
    const exit = await Effect.runPromiseExit(rung(fallback, call))
    expect(exit._tag).toBe("Failure")
    expect(calls).toHaveLength(1)
  })

  test("an exhausted quota never falls back, though a 429 carried it", async () => {
    const quota = AiError.make({ module: "Test", method: "generateText", reason: new AiError.QuotaExhaustedError({ http: { request, response: { status: 429, headers: {} } } }) })
    const { call, calls } = scripted({ "opencode:kimi-k2.6": Effect.fail(quota), "google:gemini-3.5-flash": Effect.succeed("saved") })
    const exit = await Effect.runPromiseExit(rung(fallback, call))
    expect(exit._tag).toBe("Failure")
    expect(calls).toEqual([{ model: "opencode:kimi-k2.6", isFallback: false }])
  })

  test("no fallback configured, or fallback === primary → the error passes through", async () => {
    const { call, calls } = scripted({ "opencode:kimi-k2.6": Effect.fail(transient) })
    const none = await Effect.runPromiseExit(rung(Option.none(), call))
    expect(none._tag).toBe("Failure")
    const same = await Effect.runPromiseExit(
      rung(Option.some(primary), call),
    )
    expect(same._tag).toBe("Failure")
    expect(calls).toHaveLength(2)
  })

  test("a transient failure after the call handed a tool call off never falls back: the fallback would run the tools again", async () => {
    const { call, calls } = scripted({ "opencode:kimi-k2.6": Effect.fail(transient), "google:gemini-3.5-flash": Effect.succeed("saved") })
    const handedOff = makeCallBudget().pipe(Effect.tap((budget) => Deferred.succeed(budget.handedOff, undefined)))
    expect(await Effect.runPromise(Effect.flip(rung(fallback, call, handedOff)))).toBe(transient)
    expect(calls).toEqual([{ model: "opencode:kimi-k2.6", isFallback: false }])
  })

  test("a transient failure once the call's budget is spent never falls back", async () => {
    const { call, calls } = scripted({ "opencode:kimi-k2.6": Effect.fail(transient), "google:gemini-3.5-flash": Effect.succeed("saved") })
    expect(await Effect.runPromise(Effect.flip(rung(fallback, call, makeCallBudget(0))))).toBe(transient)
    expect(calls).toEqual([{ model: "opencode:kimi-k2.6", isFallback: false }])
  })

  test("the fall back is logged with both models as annotations, neither in its text", async () => {
    const logged: Array<readonly [string, unknown, unknown]> = []
    const capture = Logger.layer([Logger.make((options) => {
      const annotations = options.fiber.getRef(References.CurrentLogAnnotations)
      logged.push([[options.message].flat().join(" "), annotations["llm.model"], annotations["llm.fallback_model"]])
    })])
    const { call } = scripted({ "opencode:kimi-k2.6": Effect.fail(transient), "google:gemini-3.5-flash": Effect.succeed("saved") })
    await Effect.runPromise(rung(fallback, call).pipe(Effect.provide(capture)))
    expect(logged).toHaveLength(1)
    expect(logged[0]?.[0]).toStartWith("exhausted retries (")
    expect(logged[0]?.[0]).not.toContain("kimi-k2.6")
    expect(logged[0]?.[0]).not.toContain("gemini-3.5-flash")
    expect(logged[0]?.slice(1)).toEqual(["opencode:kimi-k2.6", "google:gemini-3.5-flash"])
  })

  test("a healthy primary never touches the fallback", async () => {
    const { call, calls } = scripted({ "opencode:kimi-k2.6": Effect.succeed("fine") })
    const out = await Effect.runPromise(
      rung(fallback, call) as Effect.Effect<string>,
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

  test("a step without a selection fails with request.model, the selection's AiError kept as its cause", async () => {
    const settings = Layer.succeed(SettingsStore, SettingsStore.of({ load: Effect.succeed(new EngineSettings({})), setRole: () => Effect.void, set: () => Effect.void }))
    const auth = Layer.succeed(AuthStore, AuthStore.of({
      all: Effect.succeed(new Map()), get: () => Effect.succeed(Option.none()), resolveKey: () => Effect.succeed(Option.none()), set: () => Effect.void, remove: () => Effect.void,
    }))
    const failed = await Effect.runPromise(Effect.flip(LanguageModel.LanguageModel.pipe(
      Effect.flatMap(resolveModelRequest),
      Effect.provide(LanguageModelLive.pipe(Layer.provide(Layer.merge(settings, auth)))),
    )))
    expect(failed.code).toBe("request.model")
    expect(failed.message).toStartWith("AiError: Router.selection: no model configured")
    expect(failed.cause).toMatchObject({ _tag: "AiError", module: "Router", method: "selection", reason: { _tag: "UnknownError" } })
  })
})

describe("trace content and span parents", () => {
  test("a stream's reasoning reaches its span only while CurrentTraceContent is on, read when the stream runs", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const traced = (name: string) => Stream.runDrain(tapStreamTelemetry("test:stream-content")(Stream.fromIterable(streamedParts))).pipe(Effect.withSpan(name))
    await Effect.runPromise(Effect.all([
      traced("redacted"),
      traced("captured").pipe(Effect.provideService(CurrentTraceContent, true)),
    ]).pipe(Effect.withTracer(capturingTracer(spans))))
    expect(["redacted", "captured"].map((name) => spans.find((span) => span.name === name)?.attributes.get("llm.reasoning"))).toEqual(["[redacted]", "because…"])
  })

  test("EFFERENT_TRACE_CONTENT=1 is read from the ConfigProvider, and turns the content on for every call", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const traced = (name: string, value: string) => Stream.runDrain(tapStreamTelemetry("test:stream-content")(Stream.fromIterable(streamedParts))).pipe(
      Effect.withSpan(name),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({ EFFERENT_TRACE_CONTENT: value })),
    )
    await Effect.runPromise(Effect.all([traced("on", "1"), traced("other", "yes")]).pipe(Effect.withTracer(capturingTracer(spans))))
    expect(["on", "other"].map((name) => spans.find((span) => span.name === name)?.attributes.get("llm.reasoning"))).toEqual(["because…", "[redacted]"])
  })

  test("a routed call's spans nest where it is called, not where its layer was built; its content switch is the caller's", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: () => Response.json({
        choices: [{ finish_reason: "stop", message: { content: "ok", reasoning_content: "thinking it over" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    })
    const auth = Layer.succeed(AuthStore, AuthStore.of({
      all: Effect.succeed(new Map()),
      get: () => Effect.succeed(Option.some({ type: "local" as const, baseUrl: `http://127.0.0.1:${server.port}/v1` })),
      resolveKey: () => Effect.succeed(Option.none()),
      set: () => Effect.void,
      remove: () => Effect.void,
    }))
    const spans: Array<Tracer.NativeSpan> = []
    await Effect.runPromise(Effect.gen(function* () {
      const selection = yield* Effect.fromOption(parseModelSelection("span-local:parents"))
      // Built under one span, with the switch on there: neither is the calls'.
      const model = yield* LanguageModel.LanguageModel.pipe(
        Effect.provide(LanguageModelSelectionLive(selection, Option.none()).pipe(Layer.provide(auth))),
        Effect.provideService(CurrentTraceContent, true),
        Effect.withSpan("built-here"),
      )
      yield* model.generateText({ prompt: "hi" }).pipe(Effect.withSpan("called-here"))
      yield* model.generateText({ prompt: "hi" }).pipe(Effect.provideService(CurrentTraceContent, true), Effect.withSpan("called-with-content"))
    }).pipe(Effect.withTracer(capturingTracer(spans)))).finally(() => server.stop(true))
    const byId = new Map(spans.map((span) => [span.spanId, span] as const))
    const calls = spans.filter((span) => span.name === "providers.generate")
    const nearest = (span: Tracer.NativeSpan, names: ReadonlyArray<string>): string => Option.match(Option.flatMap(span.parent, (parent) => Option.fromNullishOr(byId.get(parent.spanId))), {
      onNone: () => "none",
      onSome: (parent) => names.includes(parent.name) ? parent.name : nearest(parent, names),
    })
    const outer = ["built-here", "called-here", "called-with-content"]
    expect(calls.map((span) => [nearest(span, outer), span.attributes.get("llm.reasoning")])).toEqual([
      ["called-here", "[redacted]"],
      ["called-with-content", "thinking it over"],
    ])
  })

  test("a routed call's spans carry the annotations of where it is called, not those of where its layer was built", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: () => Response.json({
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    })
    const auth = Layer.succeed(AuthStore, AuthStore.of({
      all: Effect.succeed(new Map()),
      get: () => Effect.succeed(Option.some({ type: "local" as const, baseUrl: `http://127.0.0.1:${server.port}/v1` })),
      resolveKey: () => Effect.succeed(Option.none()),
      set: () => Effect.void,
      remove: () => Effect.void,
    }))
    const spans: Array<Tracer.NativeSpan> = []
    const turnIds = { "efferent.session.id": "s-1", "efferent.run.id": "run-1", "efferent.turn": 1 }
    await Effect.runPromise(Effect.gen(function* () {
      const selection = yield* Effect.fromOption(parseModelSelection("span-local:annotations"))
      // Built inside the host's annotated region, as a layer built before the turn is.
      const model = yield* LanguageModel.LanguageModel.pipe(
        Effect.provide(LanguageModelSelectionLive(selection, Option.none()).pipe(Layer.provide(auth))),
        Effect.annotateSpans({ "host.tenant": "t-1" }),
      )
      // Called inside the turn: the host's annotations and the turn's ids.
      yield* model.generateText({ prompt: "hi" }).pipe(Effect.annotateSpans(turnIds), Effect.annotateSpans({ "host.tenant": "t-1" }))
    }).pipe(Effect.withTracer(capturingTracer(spans)))).finally(() => server.stop(true))
    const call = spans.find((span) => span.name === "providers.generate")
    expect(["efferent.session.id", "efferent.run.id", "efferent.turn", "host.tenant"].map((key) => call?.attributes.get(key))).toEqual(["s-1", "run-1", 1, "t-1"])
  })
})

/** An AuthStore with one local credential (an OpenAI-compatible URL), or none; `asked` records the providers read. */
const localAuth = (baseUrl: Option.Option<string>, asked: Array<string> = []) => Layer.succeed(AuthStore, AuthStore.of({
  all: Effect.succeed(new Map()),
  get: (provider) => Effect.sync(() => asked.push(provider)).pipe(Effect.as(Option.map(baseUrl, (url) => ({ type: "local" as const, baseUrl: url })))),
  resolveKey: () => Effect.succeed(Option.none()),
  set: () => Effect.void,
  remove: () => Effect.void,
}))

describe("the routed model's surface", () => {
  test("generateObject is routed like generateText: the selection's provider, a JSON-schema request, the decoded object", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: async (request) => {
        bodies.push(await request.json() as Record<string, unknown>)
        return Response.json({ choices: [{ finish_reason: "stop", message: { content: `{"covered":true}` } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })
      },
    })
    const value = await Effect.runPromise(Effect.gen(function* () {
      const selection = yield* Effect.fromOption(parseModelSelection("object-local:judge"))
      const model = yield* LanguageModel.LanguageModel.pipe(
        Effect.provide(LanguageModelSelectionLive(selection, Option.none()).pipe(Layer.provide(localAuth(Option.some(`http://127.0.0.1:${server.port}/v1`))))),
      )
      const response = yield* model.generateObject({ prompt: "Is it covered?", objectName: "verdict", schema: Schema.Struct({ covered: Schema.Boolean }) })
      return response.value
    })).finally(() => server.stop(true))
    expect(value).toEqual({ covered: true })
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ model: "judge", response_format: { type: "json_schema", json_schema: { name: "verdict" } } })
  })

  test("a credential the call cannot have fails it with an AiError (authentication), on every method; no retry, no fallback", async () => {
    const asked: Array<string> = []
    const failures = await Effect.runPromise(Effect.gen(function* () {
      const selection = yield* Effect.fromOption(parseModelSelection("opencode:glm-5.2"))
      const fallback = yield* Effect.fromOption(parseModelSelection("google:gemini-3.5-flash"))
      const model = yield* LanguageModel.LanguageModel.pipe(
        Effect.provide(LanguageModelSelectionLive(selection, Option.some(fallback)).pipe(Layer.provide(localAuth(Option.none(), asked)))),
      )
      return yield* Effect.all([
        Effect.flip(model.generateText({ prompt: "hi" })),
        Effect.flip(model.generateObject({ prompt: "hi", schema: Schema.Struct({ ok: Schema.Boolean }) })),
        Effect.flip(Stream.runDrain(model.streamText({ prompt: "hi" }))),
      ])
    }))
    expect(failures.map((error) => AiError.isAiError(error) ? error.reason._tag : "escaped")).toEqual(["AuthenticationError", "AuthenticationError", "AuthenticationError"])
    expect(String(failures[0])).toContain("no credential for opencode")
    expect(asked).toEqual(["opencode", "opencode", "opencode"])
  })

  test("a call, settled or streamed, carries the model it was routed to on its finish part, under core's key", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: async (request) => {
        const { stream } = await request.json() as { readonly stream: boolean }
        return stream
          ? new Response(`data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
          : Response.json({ choices: [{ finish_reason: "stop", message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
      },
    })
    const models = await Effect.runPromise(Effect.gen(function* () {
      const selection = yield* Effect.fromOption(parseModelSelection("stamp-local:chat"))
      const model = yield* LanguageModel.LanguageModel.pipe(
        Effect.provide(LanguageModelSelectionLive(selection, Option.none()).pipe(Layer.provide(localAuth(Option.some(`http://127.0.0.1:${server.port}/v1`))))),
      )
      const settled = yield* model.generateText({ prompt: "hi" })
      const streamed = yield* Stream.runCollect(model.streamText({ prompt: "hi" }))
      return [responseModelOf(settled.content), responseModelOf(Array.from(streamed))]
    })).finally(() => server.stop(true))
    expect(models).toEqual([Option.some("stamp-local:chat"), Option.some("stamp-local:chat")])
  })

  test("its descriptor records the call policy as JSON: a field the policy leaves unset is left out, and the settings decode", async () => {
    const descriptor = await Effect.runPromise(Effect.gen(function* () {
      const selection = yield* Effect.fromOption(parseModelSelection("opencode:glm-5.2"))
      const fallback = yield* Effect.fromOption(parseModelSelection("google:gemini-3.5-flash"))
      const model = yield* LanguageModel.LanguageModel.pipe(
        Effect.provide(LanguageModelSelectionLive(selection, Option.some(fallback)).pipe(Layer.provide(localAuth(Option.none())))),
      )
      return yield* modelRequestDescriptorOf(model).pipe(
        Effect.provideService(CurrentModelCallPolicy, Option.some({ effort: "high", maxOutputTokens: undefined })),
      )
    }))
    expect(Option.getOrThrow(descriptor)).toStrictEqual({
      provider: "opencode", model: "glm-5.2",
      settings: { fallback: "google:gemini-3.5-flash", policy: { effort: "high" } },
    })
  })
})

describe("a routed call's providers.generate span", () => {
  const requests = (label: string, outcome: "ok" | "error", fallback: ReadonlyArray<[string, string]>) =>
    counterValue("llm.requests", "routed LLM calls by final outcome (after retries)", [["llm.model", label], ["outcome", outcome], ...fallback])
  /** The names of the spans' parents, `none` for a parent not captured. */
  const parentsOf = (spans: ReadonlyArray<Tracer.NativeSpan>, name: string) => {
    const byId = new Map(spans.map((span) => [span.spanId, span] as const))
    return spans.filter((span) => span.name === name).map((span) => Option.match(Option.flatMap(span.parent, (parent) => Option.fromNullishOr(byId.get(parent.spanId))), {
      onNone: () => "none",
      onSome: (parent) => parent.name,
    }))
  }

  test("encloses the call's credential, models.credentials, on every method; logs inside it carry the model; the counters count the provider's calls alone", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: async (request) => {
        const { stream } = await request.json() as { readonly stream?: boolean }
        return stream
          ? new Response(`data: {"choices":[{"delta":{"content":"{\\"ok\\":true}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
          : Response.json({ choices: [{ finish_reason: "stop", message: { content: `{"ok":true}` } }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })
      },
    })
    // A store that logs while it resolves the key, as a refresh does.
    const auth = Layer.succeed(AuthStore, AuthStore.of({
      all: Effect.succeed(new Map()),
      get: () => Effect.succeed(Option.some({ type: "local" as const, baseUrl: `http://127.0.0.1:${server.port}/v1` })),
      resolveKey: () => Effect.logInfo("refreshing the token").pipe(Effect.as(Option.none())),
      set: () => Effect.void,
      remove: () => Effect.void,
    }))
    const spans: Array<Tracer.NativeSpan> = []
    const logged: Array<readonly [string, unknown]> = []
    const capture = Logger.layer([Logger.make((options) => {
      logged.push([[options.message].flat().join(" "), options.fiber.getRef(References.CurrentLogAnnotations)["llm.model"]])
    })])
    const label = "span-local:credentials"
    await Effect.runPromise(Effect.gen(function* () {
      const selection = yield* Effect.fromOption(parseModelSelection(label))
      const model = yield* LanguageModel.LanguageModel.pipe(
        Effect.provide(LanguageModelSelectionLive(selection, Option.none()).pipe(Layer.provide(auth))),
      )
      yield* model.generateText({ prompt: "hi" })
      yield* model.generateObject({ prompt: "hi", schema: Schema.Struct({ ok: Schema.Boolean }) })
      yield* Stream.runDrain(model.streamText({ prompt: "hi" }))
    }).pipe(Effect.withTracer(capturingTracer(spans)), Effect.provide(capture))).finally(() => server.stop(true))
    expect(parentsOf(spans, "models.credentials")).toEqual(["providers.generate", "providers.generate", "providers.generate"])
    // The call's own attributes still land on providers.generate, not on its credential's span.
    expect(spans.filter((span) => span.name === "providers.generate").map((span) => [span.attributes.get("llm.model"), span.attributes.get("llm.finish_reason")])).toEqual([[label, "stop"], [label, "stop"], [label, "stop"]])
    expect(logged.filter(([message]) => message === "refreshing the token")).toEqual([["refreshing the token", label], ["refreshing the token", label], ["refreshing the token", label]])
    expect(await Promise.all([
      requests(label, "ok", [["fallback", "false"]]),
      requests(label, "ok", []),
      counterValue("llm.usage.input_tokens", "prompt tokens consumed by routed LLM calls", [["llm.model", label]]),
    ])).toEqual([2, 1, 9])
  })

  test("a credential that cannot be resolved ends it and models.credentials failed, and counts no request", async () => {
    const auth = Layer.succeed(AuthStore, AuthStore.of({
      all: Effect.succeed(new Map()),
      get: () => Effect.succeed(Option.none()),
      resolveKey: (provider) => Effect.fail(new AuthError({ provider, message: "the token refresh was refused" })),
      set: () => Effect.void,
      remove: () => Effect.void,
    }))
    const spans: Array<Tracer.NativeSpan> = []
    const label = "span-refused:credentials"
    const failures = await Effect.runPromise(Effect.gen(function* () {
      const selection = yield* Effect.fromOption(parseModelSelection(label))
      const model = yield* LanguageModel.LanguageModel.pipe(
        Effect.provide(LanguageModelSelectionLive(selection, Option.none()).pipe(Layer.provide(auth))),
      )
      return yield* Effect.all([
        Effect.flip(model.generateText({ prompt: "hi" })),
        Effect.flip(Stream.runDrain(model.streamText({ prompt: "hi" }))),
      ], { concurrency: 1 })
    }).pipe(Effect.withTracer(capturingTracer(spans))))
    expect(failures.map((error) => AiError.isAiError(error) ? error.reason._tag : "escaped")).toEqual(["AuthenticationError", "AuthenticationError"])
    expect(parentsOf(spans, "models.credentials")).toEqual(["providers.generate", "providers.generate"])
    const failed = (name: string) => spans.filter((span) => span.name === name).map((span) => span.status._tag === "Ended" && Exit.isFailure(span.status.exit))
    expect([failed("providers.generate"), failed("models.credentials")]).toEqual([[true, true], [true, true]])
    expect(await Promise.all([
      requests(label, "ok", [["fallback", "false"]]),
      requests(label, "error", [["fallback", "false"]]),
      requests(label, "ok", []),
      requests(label, "error", []),
    ])).toEqual([0, 0, 0, 0])
  })
})

describe("a routed call's budget and hand-off", () => {
  const primary = Option.getOrThrow(parseModelSelection("budget:primary"))
  const fallback = Option.getOrThrow(parseModelSelection("budget:fallback"))
  const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } }
  const probeCall: ReadonlyArray<AiResponse.PartEncoded> = [
    { type: "tool-call", id: "c1", name: "probe", params: {}, providerExecuted: false },
    { type: "finish", reason: "tool-calls", usage },
  ]
  const Probe = Tool.make("probe", { parameters: Schema.Struct({}), success: Schema.String, failureMode: "error" })
  const kit = Toolkit.make(Probe)
  const unavailable = AiError.make({
    module: "Test",
    method: "generateText",
    reason: AiError.reasonFromHttpStatus({ status: 503, http: { request: { method: "POST", url: "https://gw.example/chat", urlParams: [], headers: {} }, response: { status: 503, headers: {} } } }),
  })

  /** A provider that counts its calls and answers with `reply`. */
  const provider = (calls: Ref.Ref<number>, reply: Effect.Effect<ReadonlyArray<AiResponse.PartEncoded>>) => LanguageModel.make({
    generateText: () => Ref.update(calls, (n) => n + 1).pipe(Effect.andThen(reply), Effect.map((parts) => [...parts])),
    streamText: () => Stream.die("not streamed"),
  })

  /**
   * A routed call over two scripted providers, as the routed model runs one:
   * one budget for the call, each rung's toolkit watched for the hand-off
   * and its attempts retried within the budget, then the fallback rung.
   */
  const routed = (models: { readonly primary: LanguageModel.LanguageModel; readonly fallback: LanguageModel.LanguageModel }, options: { readonly prompt: string; readonly toolkit?: unknown }) =>
    makeCallBudget().pipe(Effect.flatMap((budget) => withFallbackRung(primary, Option.some(fallback), (selection, isFallback) =>
      ((isFallback ? models.fallback : models.primary).generateText(withHandOff(options, budget) as never) as Effect.Effect<LanguageModel.GenerateTextResponse<Toolkit.Tools<typeof kit>>, AiError.AiError>).pipe(
        retryableLlm(`${selection.provider}:${selection.modelId}`, budget),
      ), budget)))

  interface Counts {
    readonly primary: Ref.Ref<number>
    readonly fallback: Ref.Ref<number>
    readonly runs: Ref.Ref<number>
    /** Done once the tool's handler has started: the clock is moved only then, so no bound fires before the call reached its tool. */
    readonly started: Deferred.Deferred<void>
  }
  /** Runs `body` on a test clock with fresh call counters for both providers and the tool. */
  const counted = <A>(body: (counts: Counts) => Effect.Effect<A, unknown>) =>
    Effect.runPromise(Effect.gen(function* () {
      const counts = { primary: yield* Ref.make(0), fallback: yield* Ref.make(0), runs: yield* Ref.make(0), started: yield* Deferred.make<void>() }
      return yield* body(counts)
    }).pipe(Effect.orDie, Effect.provide(TestClock.layer())))
  /** The tool's handler: counted, then `then`. */
  const handler = <A, E>(counts: Counts, then: Effect.Effect<A, E>) => () =>
    Ref.update(counts.runs, (n) => n + 1).pipe(Effect.andThen(Deferred.succeed(counts.started, undefined)), Effect.andThen(then))

  test("a tool that outlasts the attempt timeout and the budget runs once, in one model call, and the call succeeds", async () => {
    const result = await counted((counts) => Effect.gen(function* () {
      const models = { primary: yield* provider(counts.primary, Effect.succeed(probeCall)), fallback: yield* provider(counts.fallback, Effect.succeed(probeCall)) }
      // A yieldable toolkit, resolved inside the call.
      const toolkit = kit.pipe(Effect.provide(kit.toLayer({ probe: handler(counts, Effect.sleep("700 seconds").pipe(Effect.as("slept"))) })))
      const fiber = yield* Effect.forkChild(Effect.exit(routed(models, { prompt: "hi", toolkit })))
      yield* Deferred.await(counts.started)
      yield* TestClock.adjust("1 hour")
      const exit = yield* Fiber.join(fiber)
      return { exit, calls: [yield* Ref.get(counts.primary), yield* Ref.get(counts.fallback), yield* Ref.get(counts.runs)] }
    }))
    expect(Exit.isSuccess(result.exit) ? result.exit.value.toolResults.map((part) => part.result) : "failed").toEqual(["slept"])
    expect(result.calls).toEqual([1, 0, 1])
  })

  test("a defect in a tool after the hand-off is not retried and never reaches the fallback", async () => {
    const result = await counted((counts) => Effect.gen(function* () {
      const models = { primary: yield* provider(counts.primary, Effect.succeed(probeCall)), fallback: yield* provider(counts.fallback, Effect.succeed(probeCall)) }
      const toolkit = yield* kit.pipe(Effect.provide(kit.toLayer({ probe: handler(counts, Effect.die("the tool broke")) })))
      const fiber = yield* Effect.forkChild(Effect.exit(routed(models, { prompt: "hi", toolkit })))
      yield* Deferred.await(counts.started)
      yield* TestClock.adjust("1 hour")
      const exit = yield* Fiber.join(fiber)
      return { died: Exit.isFailure(exit) && Cause.hasDies(exit.cause), calls: [yield* Ref.get(counts.primary), yield* Ref.get(counts.fallback), yield* Ref.get(counts.runs)] }
    }))
    expect(result).toEqual({ died: true, calls: [1, 0, 1] })
  })

  test("a transient failure in a tool after the hand-off is final: no retry, no fallback, the tool ran once", async () => {
    const result = await counted((counts) => Effect.gen(function* () {
      const models = { primary: yield* provider(counts.primary, Effect.succeed(probeCall)), fallback: yield* provider(counts.fallback, Effect.succeed(probeCall)) }
      const toolkit = yield* kit.pipe(Effect.provide(kit.toLayer({ probe: handler(counts, Effect.fail(unavailable)) })))
      const fiber = yield* Effect.forkChild(Effect.flip(routed(models, { prompt: "hi", toolkit })))
      yield* Deferred.await(counts.started)
      yield* TestClock.adjust("1 hour")
      const error = yield* Fiber.join(fiber)
      return { error, calls: [yield* Ref.get(counts.primary), yield* Ref.get(counts.fallback), yield* Ref.get(counts.runs)] }
    }))
    expect(result).toEqual({ error: unavailable, calls: [1, 0, 1] })
  })

  test("a hung provider: attempt one is cut at 300 s, attempt two at the budget's deadline; no third attempt and no fallback", async () => {
    const result = await counted((counts) => Effect.gen(function* () {
      const models = { primary: yield* provider(counts.primary, Effect.never), fallback: yield* provider(counts.fallback, Effect.never) }
      const fiber = yield* Effect.forkChild(Effect.timed(Effect.flip(routed(models, { prompt: "hi" }))))
      yield* TestClock.adjust("299 seconds")
      const beforeCut = yield* Ref.get(counts.primary)
      // Past the first cut and the backoff (1 s, jittered by at most 20%).
      yield* TestClock.adjust("3 seconds")
      const afterCut = yield* Ref.get(counts.primary)
      yield* TestClock.adjust("1 hour")
      const [elapsed, error] = yield* Fiber.join(fiber)
      return { attempts: [beforeCut, afterCut, yield* Ref.get(counts.primary)], fallback: yield* Ref.get(counts.fallback), elapsed: Duration.toMillis(elapsed), error: String(error) }
    }))
    expect(result.attempts).toEqual([1, 2, 2])
    expect(result.fallback).toBe(0)
    expect(result.elapsed).toBe(600_000)
    expect(result.error).toContain("the budget:primary call reached its 600s budget after 2 attempts and was cut off")
  })
})

describe("the routed model's hand-off", () => {
  test("a tool that fails transient after the routed model handed it off is not retried and never reaches the fallback", async () => {
    const bodies: Array<string> = []
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: async (request) => {
        const { model } = await request.json() as { readonly model: string }
        bodies.push(model)
        return Response.json({
          choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c1", function: { name: "probe", arguments: "{}" } }] } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      },
    })
    const Probe = Tool.make("probe", { parameters: Schema.Struct({}), success: Schema.String, failureMode: "error" })
    const kit = Toolkit.make(Probe)
    const runs = Ref.makeUnsafe(0)
    const unavailable = AiError.make({ module: "Test", method: "generateText", reason: new AiError.UnknownError({ description: "the sub-agent's provider is down" }) })
    const error = await Effect.runPromise(Effect.gen(function* () {
      const selection = yield* Effect.fromOption(parseModelSelection("hand-local:primary"))
      const backup = yield* Effect.fromOption(parseModelSelection("hand-local:backup"))
      const model = yield* LanguageModel.LanguageModel.pipe(
        Effect.provide(LanguageModelSelectionLive(selection, Option.some(backup)).pipe(Layer.provide(localAuth(Option.some(`http://127.0.0.1:${server.port}/v1`))))),
      )
      const toolkit = yield* kit.pipe(Effect.provide(kit.toLayer({ probe: () => Ref.update(runs, (n) => n + 1).pipe(Effect.andThen(Effect.fail(unavailable))) })))
      return yield* Effect.flip(model.generateText({ prompt: "hi", toolkit }))
    })).finally(() => server.stop(true))
    expect(error).toBe(unavailable)
    expect(bodies).toEqual(["primary"])
    expect(Ref.getUnsafe(runs)).toBe(1)
  })
})
