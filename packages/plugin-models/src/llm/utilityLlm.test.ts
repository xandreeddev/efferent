import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Tracer } from "effect"
import { CurrentModelCallPolicy, CurrentModelCallRecorder, HarnessError, harnessDefectsAsFailures, UtilityCompletion, UtilityLlm } from "@xandreed/core"
import type { ModelCallData, ModelCallRecorder } from "@xandreed/core"
import { AuthStore } from "../ports/auth-store.port.js"
import { EngineSettings, SettingsStore } from "../ports/settings-store.port.js"
import type { ReasoningEffort } from "@xandreed/core"
import { CurrentModelEndpoints } from "../ports/model-endpoints.port.js"
import { UtilityLlmLive } from "./utilityLlm.js"

/** One utility completion under these settings, against an endpoint that sends gateway extensions: the request body it sent. */
const completeUnder = async (settings: {
  readonly reasoningEffort?: ReasoningEffort
  readonly fastReasoningEffort?: ReasoningEffort
}, pinned: Option.Option<ReasoningEffort> = Option.none()) => {
  const bodies: Array<Record<string, unknown>> = []
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: async (request) => {
      bodies.push(await request.json() as Record<string, unknown>)
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: "a title" } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })
    },
  })
  const store = Layer.succeed(SettingsStore, SettingsStore.of({
    load: Effect.succeed(new EngineSettings({
      model: Option.some("gw:general"),
      fastModel: Option.some("gw:fast"),
      reasoningEffort: Option.fromNullishOr(settings.reasoningEffort),
      fastReasoningEffort: Option.fromNullishOr(settings.fastReasoningEffort),
    })),
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
  const text = await Effect.runPromise(Effect.gen(function* () {
    const utility = yield* UtilityLlm
    return (yield* utility.complete("Name this conversation")).text
  }).pipe(
    Effect.provideService(CurrentModelCallPolicy, Option.map(pinned, (effort) => ({ effort }))),
    Effect.provide(UtilityLlmLive.pipe(Layer.provide(Layer.merge(store, auth)))),
    Effect.provideService(CurrentModelEndpoints, { gw: { url: `http://127.0.0.1:${server.port}/v1`, standardOnly: false } }),
  )).finally(() => server.stop(true))
  expect(text).toBe("a title")
  return bodies[0] ?? {}
}

/** One utility completion against an endpoint that answers every request with this status and body: the failure. */
const failureUnder = async (status: number, body: unknown) => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(body, { status }) })
  const store = Layer.succeed(SettingsStore, SettingsStore.of({
    load: Effect.succeed(new EngineSettings({ model: Option.some("gw:general") })),
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
  return await Effect.runPromise(Effect.flip(Effect.gen(function* () {
    const utility = yield* UtilityLlm
    return yield* utility.complete("Name this conversation")
  })).pipe(
    Effect.provide(UtilityLlmLive.pipe(Layer.provide(Layer.merge(store, auth)))),
    Effect.provideService(CurrentModelEndpoints, { gw: { url: `http://127.0.0.1:${server.port}/v1`, standardOnly: false } }),
  )).finally(() => server.stop(true))
}

const completionWithRecorder = async (recorder: ModelCallRecorder) => {
  const requests: Array<string> = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
    requests.push(request.url)
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: "a title" } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })
  } })
  const stores = Layer.merge(
    Layer.succeed(SettingsStore, SettingsStore.of({
      load: Effect.succeed(new EngineSettings({ model: Option.some("gw:general"), fastModel: Option.some("gw:fast") })),
      setRole: () => Effect.void, set: () => Effect.void,
    })),
    Layer.succeed(AuthStore, AuthStore.of({
      all: Effect.succeed(new Map()), get: () => Effect.succeed(Option.none()), resolveKey: () => Effect.succeed(Option.none()),
      set: () => Effect.void, remove: () => Effect.void,
    })),
  )
  const result = await Effect.runPromise(Effect.gen(function* () {
    const utility = yield* UtilityLlm
    return yield* Effect.result(harnessDefectsAsFailures(utility.complete("Name this conversation")))
  }).pipe(
    Effect.provideService(CurrentModelCallRecorder, recorder),
    Effect.provide(UtilityLlmLive.pipe(Layer.provide(stores))),
    Effect.provideService(CurrentModelEndpoints, { gw: { url: `http://127.0.0.1:${server.port}/v1`, standardOnly: false } }),
  )).finally(() => server.stop(true))
  return { result, requests }
}

describe("UtilityLlmLive", () => {
  test("a helper records once with its actual fast selection and returns that selection", async () => {
    const calls: Array<ModelCallData> = []
    const observed = await completionWithRecorder({ record: (data) => Effect.sync(() => { calls.push(data) }) })
    expect(observed.result._tag).toBe("Success")
    if (observed.result._tag !== "Success") return
    expect(observed.result.success).toBeInstanceOf(UtilityCompletion)
    expect(observed.result.success.model).toMatchObject({ provider: "gw", modelId: "fast" })
    expect(observed.requests).toHaveLength(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      purpose: "Helper", method: "Text", attempt: 1,
      usage: { _tag: "Known", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
      outcome: { _tag: "Completed" },
    })
    expect(calls[0]?.model).toEqual(Option.some(observed.result.success.model!))
    expect(calls[0]?.runId).toEqual(Option.none())
    expect(calls[0]?.run).toEqual(Option.none())
    expect(calls[0]?.step).toEqual(Option.none())
  })

  test("a recorder failure remains the original TurnError and never becomes a soft UtilityError", async () => {
    const failure = new HarnessError({ code: "events.encode", message: "the model call could not be recorded" })
    const calls: Array<ModelCallData> = []
    const observed = await completionWithRecorder({ record: (data) => Effect.sync(() => { calls.push(data) }).pipe(Effect.andThen(Effect.fail(failure))) })
    expect(observed.result._tag === "Failure" ? observed.result.failure : undefined).toBe(failure)
    expect(observed.requests).toHaveLength(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.outcome).toEqual({ _tag: "Completed" })
  })

  test("a refused call fails with the provider's AiError as the cause and its text as the message", async () => {
    const failed = await failureUnder(400, { error: { message: "the request is malformed" } })
    expect(failed._tag).toBe("UtilityError")
    expect(failed.message).toStartWith("AiError: ")
    expect(failed.message).toContain("the request is malformed")
    expect(failed.cause).toMatchObject({ _tag: "AiError", module: "Models", method: "request" })
  })

  test("completes on the fast model at the fast role's effort, else the general one; a policy the caller pinned wins", async () => {
    expect(await completeUnder({ reasoningEffort: "low", fastReasoningEffort: "medium" })).toMatchObject({ model: "fast", reasoning_effort: "medium" })
    expect(await completeUnder({ reasoningEffort: "low" })).toMatchObject({ reasoning_effort: "low" })
    expect(await completeUnder({})).not.toHaveProperty("reasoning_effort")
    expect(await completeUnder({ fastReasoningEffort: "medium" }, Option.some("high"))).toMatchObject({ reasoning_effort: "high" })
  })

  test("built with endpoints E under one call policy, a completion called elsewhere under another goes to E with the caller's policy", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const builtCalls: Array<ModelCallData> = []
    const calledCalls: Array<ModelCallData> = []
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: async (request) => {
        bodies.push(await request.json() as Record<string, unknown>)
        return Response.json({ choices: [{ finish_reason: "stop", message: { content: "a title" } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })
      },
    })
    const store = Layer.succeed(SettingsStore, SettingsStore.of({
      load: Effect.succeed(new EngineSettings({ model: Option.some("gw:general") })),
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
    await Effect.runPromise(Effect.gen(function* () {
      const utility = yield* UtilityLlm.pipe(
        Effect.provide(UtilityLlmLive.pipe(Layer.provide(Layer.merge(store, auth)))),
        Effect.provideService(CurrentModelEndpoints, { gw: { url: `http://127.0.0.1:${server.port}/v1`, standardOnly: false } }),
        Effect.provideService(CurrentModelCallPolicy, Option.some({ effort: "low" as const })),
        Effect.provideService(CurrentModelCallRecorder, { record: (data) => Effect.sync(() => { builtCalls.push(data) }) }),
      )
      yield* utility.complete("Name this conversation").pipe(
        Effect.provideService(CurrentModelEndpoints, {}),
        Effect.provideService(CurrentModelCallPolicy, Option.some({ effort: "high" as const })),
        Effect.provideService(CurrentModelCallRecorder, { record: (data) => Effect.sync(() => { calledCalls.push(data) }) }),
      )
    })).finally(() => server.stop(true))
    expect(bodies.map((body) => [body["model"], body["reasoning_effort"]])).toEqual([["general", "high"]])
    expect(builtCalls).toEqual([])
    expect(calledCalls).toHaveLength(1)
    expect(calledCalls[0]?.purpose).toBe("Helper")
  })

  test("a completion is a models.utility span where it is called, around its providers.generate", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: () => Response.json({ choices: [{ finish_reason: "stop", message: { content: "a title" } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
    })
    const store = Layer.succeed(SettingsStore, SettingsStore.of({
      load: Effect.succeed(new EngineSettings({ model: Option.some("gw:general") })),
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
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      },
    })
    await Effect.runPromise(Effect.gen(function* () {
      const utility = yield* UtilityLlm.pipe(Effect.provide(UtilityLlmLive.pipe(Layer.provide(Layer.merge(store, auth)))), Effect.withSpan("built-here"))
      yield* utility.complete("Name this conversation").pipe(Effect.withSpan("called-here"))
    }).pipe(
      Effect.provideService(CurrentModelEndpoints, { gw: { url: `http://127.0.0.1:${server.port}/v1`, standardOnly: false } }),
      Effect.withTracer(tracer),
    )).finally(() => server.stop(true))
    const byId = new Map(spans.map((span) => [span.spanId, span] as const))
    const parentOf = (name: string) => spans.filter((span) => span.name === name).map((span) =>
      Option.match(Option.flatMap(span.parent, (parent) => Option.fromNullishOr(byId.get(parent.spanId))), { onNone: () => "none", onSome: (parent) => parent.name }))
    expect([parentOf("models.utility"), parentOf("providers.generate"), parentOf("models.credentials")]).toEqual([["called-here"], ["models.utility"], ["providers.generate"]])
  })
})
