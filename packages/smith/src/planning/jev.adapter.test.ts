import { describe, expect, test } from "bun:test"
import { ConfigProvider, Context, Effect, Option, Redacted, Ref } from "effect"
import { AuthError, AuthStore, UserMessage } from "@xandreed/core"
import { makeEvaluationModel } from "@xandreed/ai"
import { jevTransport, planningWithEvaluationModel, smithPlanningPlugin, SmithPlanningTransport } from "./jev.adapter.js"
import { SmithPlanning } from "../coding/planning.port.js"
import type { PlanningFetch } from "./transport.port.js"

describe("Jev planning through the production decision adapter", () => {
  test("sends the current message and conversation through the evaluation protocol", async () => {
    const calls: ReadonlyArray<{ body: unknown; model: string | null; protocol: string | null }>[] = []
    const transport: PlanningFetch = async (_url, options) => {
      const headers = new Headers(options?.headers)
      calls.push([{ body: JSON.parse(String(options?.body)), model: headers.get("ai-model-id"), protocol: headers.get("ai-evaluation-model-specification-version") }])
      return Response.json({ answers: { approach: { type: "choice", choice: "plan" } } })
    }
    const result = await Effect.runPromise(Effect.gen(function* () {
      const model = yield* makeEvaluationModel({ model: "typesafe-ai/jev", transport: jevTransport("https://example.invalid/evaluation-model", Redacted.make("fixture"), transport) })
      return yield* planningWithEvaluationModel(model).decide({ userMessage: new UserMessage({ text: "Yes, implement that" }), history: [{ role: "user", content: "Replace the persistence architecture" }] })
    }))
    expect(result.mode).toBe("plan")
    expect(calls[0]?.[0]).toMatchObject({ model: "typesafe-ai/jev", protocol: "4", body: { state: { userMessage: "Yes, implement that", recentConversation: [{ role: "user", content: "Replace the persistence architecture" }] } } })
  })

  test("rejects unknown choices and HTTP failures instead of treating them as direct decisions", async () => {
    const attempt = (response: Response) => Effect.runPromise(Effect.gen(function* () {
      const transport: PlanningFetch = async () => response
      const model = yield* makeEvaluationModel({ model: "typesafe-ai/jev", transport: jevTransport("https://example.invalid/evaluation-model", Redacted.make("fixture"), transport) })
      return yield* Effect.result(planningWithEvaluationModel(model).decide({ userMessage: new UserMessage({ text: "Fix it" }), history: [] }))
    }))
    expect((await attempt(Response.json({ answers: { approach: { type: "choice", choice: "publish" } } })))._tag).toBe("Failure")
    expect((await attempt(new Response("unavailable", { status: 503 })))._tag).toBe("Failure")
  })

  test("Gateway Jev carries SDK protocol and auth metadata; missing protocol remains a failed decision", async () => {
    const calls: ReadonlyArray<{ protocol: string | null; authMethod: string | null; state: unknown }>[] = []
    const gateway: PlanningFetch = async (_url, options) => {
      const headers = new Headers(options?.headers)
      const protocol = headers.get("ai-gateway-protocol-version")
      const authMethod = headers.get("ai-gateway-auth-method")
      const body = JSON.parse(String(options?.body))
      calls.push([{ protocol, authMethod, state: body.state }])
      return protocol === "0.0.1" && authMethod === "api-key"
        ? Response.json({ answers: { approach: { type: "choice", choice: "direct", probabilities: { direct: 0.97, plan: 0.03 } } }, usage: { inputTokens: 345, outputTokens: 33 }, warnings: [] })
        : Response.json({ error: { message: "Unsupported gateway protocol version", type: "invalid_request_error", code: 400 } }, { status: 400 })
    }
    const result = await Effect.runPromise(Effect.gen(function* () {
      const input = { userMessage: new UserMessage({ text: "hello" }), history: [] }
      const accepted = yield* makeEvaluationModel({ model: "typesafe-ai/jev", transport: jevTransport("https://example.invalid/evaluation-model", Redacted.make("fixture"), gateway) })
      const decision = yield* planningWithEvaluationModel(accepted).decide(input)
      const stripped: PlanningFetch = async (url, options) => {
        const headers = new Headers(options?.headers)
        headers.delete("ai-gateway-protocol-version")
        return gateway(url, { ...options, headers })
      }
      const rejected = yield* makeEvaluationModel({ model: "typesafe-ai/jev", transport: jevTransport("https://example.invalid/evaluation-model", Redacted.make("fixture"), stripped) })
      return { decision, rejection: yield* Effect.result(planningWithEvaluationModel(rejected).decide(input)) }
    }))
    expect(result.decision).toEqual({ mode: "direct", reason: "Jev selected direct" })
    expect(result.rejection).toMatchObject({ _tag: "Failure", failure: { code: "planning.unavailable", message: "HarnessError: Jev evaluation returned HTTP 400" } })
    expect(calls.flat()).toEqual([
      { protocol: "0.0.1", authMethod: "api-key", state: { userMessage: "hello", recentConversation: [] } },
      { protocol: null, authMethod: "api-key", state: { userMessage: "hello", recentConversation: [] } },
    ])
  })

  test("uses the configured System One model while retaining strict production answer checks", async () => {
    const calls: unknown[] = []
    const transport: PlanningFetch = async (_url, options) => {
      expect(new Headers(options?.headers).has("ai-gateway-protocol-version")).toBe(false)
      expect(new Headers(options?.headers).has("ai-gateway-auth-method")).toBe(false)
      calls.push(JSON.parse(String(options?.body)))
      return Response.json({ model: "jev-1.13", answers: { approach: { type: "choice", choice: "direct", confidence: 0.95 } } })
    }
    const result = await Effect.runPromise(Effect.gen(function* () {
      const model = yield* makeEvaluationModel({ model: "jev-1.13", transport: jevTransport("https://example.invalid/systemone", Redacted.make("fixture"), transport, "systemone") })
      return yield* planningWithEvaluationModel(model).decide({ userMessage: new UserMessage({ text: "Explain this function" }), history: [] })
    }))
    expect(result.mode).toBe("direct")
    expect(calls[0]).toMatchObject({ model: "jev-1.13", state: { userMessage: "Explain this function" } })
  })

  test("a saved credential failure leaves planning available as a typed unavailable decision", async () => {
    const calls: unknown[] = []
    const services = Context.make(AuthStore, {
      all: Effect.succeed(new Map()), get: () => Effect.succeed(Option.none()),
      resolveKey: () => Effect.fail(new AuthError({ provider: "opencode", message: "fixture credential failure" })),
      set: () => Effect.void, remove: () => Effect.void,
    }).pipe(Context.add(SmithPlanningTransport, {
      apiKey: Option.none(), fetch: async () => { calls.push("unexpected request"); return Response.json({}) },
    }))
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const built = yield* smithPlanningPlugin.build({ apiKeyEnv: "SMITH_TEST_ABSENT_JEV_KEY", apiKeyProvider: "opencode" }, services)
      const planning = Context.getUnsafe(built, SmithPlanning)
      return yield* Effect.result(planning.decide({ userMessage: new UserMessage({ text: "Implement the feature" }), history: [] }))
    })))
    expect(result).toMatchObject({ _tag: "Failure", failure: { code: "planning.auth", message: "Saved Jev credential could not be resolved" } })
    expect(calls).toHaveLength(0)
  })

  test("the default Vercel saved key is refreshed on the next decision without rebuilding the plugin", async () => {
    const headers: ReadonlyArray<string>[] = []
    const providers: string[] = []
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const key = yield* Ref.make(Redacted.make("fixture-rejected"))
      const services = Context.make(AuthStore, {
        all: Effect.succeed(new Map()), get: () => Effect.succeed(Option.none()),
        resolveKey: (provider) => Effect.sync(() => providers.push(provider)).pipe(Effect.andThen(Ref.get(key)), Effect.map(Option.some)), set: () => Effect.void, remove: () => Effect.void,
      }).pipe(Context.add(SmithPlanningTransport, {
        apiKey: Option.none(), fetch: async (_url, options) => {
          const authorization = new Headers(options?.headers).get("authorization") ?? ""
          headers.push([authorization])
          return authorization === "Bearer fixture-refreshed" ? Response.json({ answers: { approach: { type: "choice", choice: "direct" } } }) : new Response("rejected", { status: 401 })
        },
      }))
      const built = yield* smithPlanningPlugin.build({ apiKeyEnv: "SMITH_TEST_ABSENT_JEV_KEY" }, services)
      const planning = Context.getUnsafe(built, SmithPlanning)
      const input = { userMessage: new UserMessage({ text: "Inspect this file" }), history: [] }
      const rejected = yield* Effect.result(planning.decide(input))
      yield* Ref.set(key, Redacted.make("fixture-refreshed"))
      const refreshed = yield* planning.decide(input)
      return { rejected, refreshed }
    })))
    expect(result.rejected._tag).toBe("Failure")
    expect(result.refreshed.mode).toBe("direct")
    expect(providers).toEqual(["vercel", "vercel"])
    expect(headers.flat()).toEqual(["Bearer fixture-rejected", "Bearer fixture-refreshed"])
  })

  test("empty environment keys fall back to saved auth and unavailable keys never dispatch", async () => {
    const headers: string[] = []
    const providers: string[] = []
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const saved = yield* Ref.make(Option.some(Redacted.make("fixture-saved")))
      const services = Context.make(AuthStore, {
        all: Effect.succeed(new Map()), get: () => Effect.succeed(Option.none()),
        resolveKey: (provider) => Effect.sync(() => providers.push(provider)).pipe(Effect.andThen(Ref.get(saved))),
        set: () => Effect.void, remove: () => Effect.void,
      }).pipe(Context.add(SmithPlanningTransport, {
        apiKey: Option.none(), fetch: async (_url, options) => {
          headers.push(new Headers(options?.headers).get("authorization") ?? "")
          return Response.json({ answers: { approach: { type: "choice", choice: "direct" } } })
        },
      }))
      const built = yield* smithPlanningPlugin.build({}, services)
      const planning = Context.getUnsafe(built, SmithPlanning)
      const decide = (value: string) => planning.decide({ userMessage: new UserMessage({ text: "Inspect this file" }), history: [] }).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ AI_GATEWAY_API_KEY: value })),
      )
      const recovered = yield* Effect.forEach(["", " \t\n "], decide)
      yield* Ref.set(saved, Option.none())
      const unavailable = yield* Effect.forEach(["", " \t\n "], (value) => Effect.result(decide(value)))
      yield* Ref.set(saved, Option.some(Redacted.make(" \t ")))
      const invalidSaved = yield* Effect.result(decide(""))
      return { recovered, unavailable, invalidSaved }
    })))
    expect(result.recovered.map((value) => value.mode)).toEqual(["direct", "direct"])
    expect(result.unavailable).toEqual([
      expect.objectContaining({ _tag: "Failure", failure: expect.objectContaining({ code: "planning.unavailable" }) }),
      expect.objectContaining({ _tag: "Failure", failure: expect.objectContaining({ code: "planning.unavailable" }) }),
    ])
    expect(result.invalidSaved).toMatchObject({ _tag: "Failure", failure: { code: "planning.unavailable" } })
    expect(providers).toEqual(["vercel", "vercel", "vercel", "vercel", "vercel"])
    expect(headers).toEqual(["Bearer fixture-saved", "Bearer fixture-saved"])
  })
})
