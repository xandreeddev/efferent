import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Tracer } from "effect"
import { AuthStore, CurrentModelCallPolicy, EngineSettings, SettingsStore, UtilityLlm } from "@xandreed/core"
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

describe("UtilityLlmLive", () => {
  test("a refused call fails with the provider's AiError as the cause and its text as the message", async () => {
    const failed = await failureUnder(400, { error: { message: "the request is malformed" } })
    expect(failed._tag).toBe("UtilityError")
    expect(failed.message).toStartWith("AiError: ")
    expect(failed.message).toContain("the request is malformed")
    expect(failed.cause).toMatchObject({ _tag: "AiError", method: "generateText" })
  })

  test("completes on the fast model at the fast role's effort, else the general one; a policy the caller pinned wins", async () => {
    expect(await completeUnder({ reasoningEffort: "low", fastReasoningEffort: "medium" })).toMatchObject({ model: "fast", reasoning_effort: "medium" })
    expect(await completeUnder({ reasoningEffort: "low" })).toMatchObject({ reasoning_effort: "low" })
    expect(await completeUnder({})).not.toHaveProperty("reasoning_effort")
    expect(await completeUnder({ fastReasoningEffort: "medium" }, Option.some("high"))).toMatchObject({ reasoning_effort: "high" })
  })

  test("built with endpoints E under one call policy, a completion called elsewhere under another goes to E with the caller's policy", async () => {
    const bodies: Array<Record<string, unknown>> = []
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
      )
      yield* utility.complete("Name this conversation").pipe(
        Effect.provideService(CurrentModelEndpoints, {}),
        Effect.provideService(CurrentModelCallPolicy, Option.some({ effort: "high" as const })),
      )
    })).finally(() => server.stop(true))
    expect(bodies.map((body) => [body["model"], body["reasoning_effort"]])).toEqual([["general", "high"]])
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
