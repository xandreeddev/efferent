import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
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

describe("UtilityLlmLive", () => {
  test("completes on the fast model at the fast role's effort, else the general one; a policy the caller pinned wins", async () => {
    expect(await completeUnder({ reasoningEffort: "low", fastReasoningEffort: "medium" })).toMatchObject({ model: "fast", reasoning_effort: "medium" })
    expect(await completeUnder({ reasoningEffort: "low" })).toMatchObject({ reasoning_effort: "low" })
    expect(await completeUnder({})).not.toHaveProperty("reasoning_effort")
    expect(await completeUnder({ fastReasoningEffort: "medium" }, Option.some("high"))).toMatchObject({ reasoning_effort: "high" })
  })
})
