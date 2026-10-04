import { expect, test } from "bun:test"
import { Context, Effect, Option, Redacted, Schema } from "effect"
import { AuthStore, UserMessage } from "@xandreed/core"
import { ModelTransport } from "@xandreed/plugin-models"
import type { ModelFetch } from "@xandreed/plugin-models"
import { SmithPlanning, smithPlanningPlugin } from "@xandreed/smith"
import { VERCEL_FLASH_PRICE, VERCEL_JEV_PRICE } from "./smith-budget.entity.js"
import { makeSmithBudget } from "./smith-budget.entity.functions.js"
import { smithTrialPlanningOptions } from "./smith-coding-trial.entity.functions.js"
import { smithLiveTransport } from "./smith-live-transport.adapter.js"

test("live Gateway admission guards production planning and coding HTTP before dispatch", async () => {
  const dispatched: ReadonlyArray<{ url: string; body: string; model: string | null }>[] = []
  const providers: string[] = []
  const fetchImpl: ModelFetch = async (url, init) => {
    dispatched.push([{ url: String(url), body: String(init?.body), model: new Headers(init?.headers).get("ai-model-id") }])
    return Response.json({ answers: { approach: { type: "choice", choice: "direct" } } })
  }
  const seen = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const budget = yield* makeSmithBudget({ spendCapUsd: 0.02, maxRequests: 2, maxInputBytesPerRequest: 24_000, maxOutputTokensPerRequest: 1000, unpricedSelectors: [], maxUnpricedRequests: 0 }, [VERCEL_FLASH_PRICE, VERCEL_JEV_PRICE])
    const transport = yield* smithLiveTransport(budget, 1000, fetchImpl)
    const built = yield* transport.plugin.build({}, Context.empty())
    const services = Context.add(built, AuthStore, AuthStore.of({
      all: Effect.succeed(new Map()), get: () => Effect.succeed(Option.none()), set: () => Effect.void, remove: () => Effect.void,
      resolveKey: (provider) => Effect.sync(() => { providers.push(provider); return Option.some(Redacted.make("fixture-gateway-key")) }),
    }))
    const options = smithTrialPlanningOptions(VERCEL_FLASH_PRICE.selector, VERCEL_FLASH_PRICE.selector)
    const planningServices = yield* smithPlanningPlugin.build({ ...options, apiKeyEnv: "SMITH_TEST_ABSENT_JEV_KEY" }, services)
    const planning = Context.getUnsafe(planningServices, SmithPlanning)
    const decision = yield* planning.decide({ userMessage: new UserMessage({ text: "Explain the implementation" }), history: [] })
    const model = Context.getUnsafe(built, ModelTransport)
    yield* Effect.tryPromise(() => model.fetch("https://ai-gateway.vercel.sh/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "deepseek/deepseek-v4.1-flash", max_tokens: 1000 }) }))
    const exhausted = yield* Effect.result(planning.decide({ userMessage: new UserMessage({ text: "Explain it again" }), history: [] }))
    const unknown = yield* Effect.result(Effect.tryPromise(() => model.fetch("https://ai-gateway.vercel.sh/v1/chat/completions", { body: JSON.stringify({ model: "unverified", max_tokens: 1000 }) })))
    const wrongEndpoint = yield* Effect.result(Effect.tryPromise(() => model.fetch("https://fixture.invalid/opencode.ai", { body: JSON.stringify({ model: "deepseek/deepseek-v4.1-flash", max_tokens: 1000 }) })))
    const requests = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ protocol: Schema.String, selector: Schema.String, reservedUsd: Schema.Number, sourceUrl: Schema.String })))(yield* transport.requests)
    return { decision, exhausted, unknown, wrongEndpoint, requests, summary: yield* budget.summary }
  })))
  expect(seen.decision.mode).toBe("direct")
  expect([seen.exhausted, seen.unknown, seen.wrongEndpoint].every((result) => result._tag === "Failure")).toBe(true)
  expect(providers).toEqual(["vercel", "vercel"])
  expect(dispatched.flat()).toHaveLength(2)
  expect(dispatched[0]?.[0]?.url).toBe("https://ai-gateway.vercel.sh/v4/ai/evaluation-model")
  expect(dispatched[0]?.[0]?.model).toBe("typesafe-ai/jev")
  expect(dispatched[0]?.[0]?.body).not.toContain('"model"')
  expect(seen.requests.map((request) => request.selector)).toEqual([VERCEL_JEV_PRICE.selector, VERCEL_FLASH_PRICE.selector])
  expect(seen.requests.map((request) => request.protocol)).toEqual(["evaluation-model-v4", "chat-completions"])
  expect(seen.requests.every((request) => request.reservedUsd > 0)).toBe(true)
  expect(seen.summary.requests).toBe(2)
  expect(smithTrialPlanningOptions("openai-codex:fixture", VERCEL_FLASH_PRICE.selector).apiKeyProvider).toBe("vercel")
  expect(smithTrialPlanningOptions("openai-codex:fixture", "opencode:deepseek-v4-flash").apiKeyProvider).toBe("opencode")
})
