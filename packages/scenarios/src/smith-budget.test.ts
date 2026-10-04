import { expect, test } from "bun:test"
import { Effect, Option, Result } from "effect"
import { FLASH_PRICE, JEV_PRICE, VERCEL_FLASH_PRICE, VERCEL_JEV_PRICE } from "./smith-budget.entity.js"
import { makeSmithBudget, validateSmithCampaignModels } from "./smith-budget.entity.functions.js"
import { runSmithMatrix } from "./smithMatrix.js"

const limits = { spendCapUsd: 0.001, maxRequests: 10, maxInputBytesPerRequest: 200_000, maxOutputTokensPerRequest: 1000, unpricedSelectors: ["openai-codex:subscription"], maxUnpricedRequests: 1 }
test("campaign selector admission rejects an unpriced paid controller before bootstrap", async () => {
  const unknown = await Effect.runPromise(Effect.result(validateSmithCampaignModels("opencode:gpt-6-astra", FLASH_PRICE.selector, [FLASH_PRICE])))
  const subscription = await Effect.runPromise(validateSmithCampaignModels("openai-codex:gpt-fixture", FLASH_PRICE.selector, [FLASH_PRICE]))
  const paid = await Effect.runPromise(validateSmithCampaignModels(FLASH_PRICE.selector, FLASH_PRICE.selector, [FLASH_PRICE]))
  expect(Result.isFailure(unknown)).toBe(true)
  expect(subscription).toEqual(["openai-codex:gpt-fixture"])
  expect(paid).toEqual([])
  expect(await Effect.runPromise(runSmithMatrix(["--live", "--main", "opencode:gpt-6-astra", "--fast", FLASH_PRICE.selector, "--admit-subscription"]).pipe(Effect.scoped))).toBe(2)
  expect(await Effect.runPromise(validateSmithCampaignModels(VERCEL_FLASH_PRICE.selector, VERCEL_FLASH_PRICE.selector, [VERCEL_FLASH_PRICE]))).toEqual([])
  expect((await Effect.runPromise(Effect.result(validateSmithCampaignModels("vercel:unverified-model", VERCEL_FLASH_PRICE.selector, [VERCEL_FLASH_PRICE]))))._tag).toBe("Failure")
})
test("admission refuses missing price/token bounds and reserves conservative cost atomically", async () => {
  const body = JSON.stringify({ model: "deepseek-v4-flash", max_tokens: 1000 })
  const perRequest = (new TextEncoder().encode(body).length * FLASH_PRICE.inputUsdPerMillion + 1000 * FLASH_PRICE.outputUsdPerMillion) / 1_000_000
  const atomicLimits = { ...limits, spendCapUsd: perRequest * 3.5 }
  const evidence = await Effect.runPromise(Effect.gen(function* () {
    const budget = yield* makeSmithBudget(atomicLimits, [FLASH_PRICE])
    const missingBound = yield* Effect.result(budget.reserve("opencode", JSON.stringify({ model: "deepseek-v4-flash" })))
    const unknown = yield* Effect.result(budget.reserve("opencode", JSON.stringify({ model: "unknown", max_tokens: 1000 })))
    const calls = yield* Effect.forEach([1,2,3,4], () => Effect.result(budget.reserve("opencode", body)), { concurrency: "unbounded" })
    const subscription = yield* Effect.result(budget.reserve("openai-codex", JSON.stringify({ model: "subscription", max_output_tokens: 500 })))
    const secondSubscription = yield* Effect.result(budget.reserve("openai-codex", JSON.stringify({ model: "subscription", max_output_tokens: 500 })))
    return { missingBound, unknown, calls, subscription, secondSubscription, summary: yield* budget.summary }
  }))
  expect(Result.isFailure(evidence.missingBound)).toBe(true)
  expect(Result.isFailure(evidence.unknown)).toBe(true)
  expect(evidence.calls.filter(Result.isSuccess)).toHaveLength(3)
  expect(Result.isSuccess(evidence.subscription)).toBe(true)
  expect(Result.isFailure(evidence.secondSubscription)).toBe(true)
  expect(evidence.summary.pricedReservedUsd).toBeLessThanOrEqual(atomicLimits.spendCapUsd)
  expect(evidence.summary.unpricedRequests).toBe(1)
  expect(evidence.summary.unpricedOutputTokensBound).toBeNull()
})

test("subscription requests have honest unknown output caps and free-output Jev reserves its input price", async () => {
  const evidence = await Effect.runPromise(Effect.gen(function* () {
    const budget = yield* makeSmithBudget(limits, [FLASH_PRICE, JEV_PRICE])
    const subscription = yield* budget.reserve("openai-codex", JSON.stringify({ model: "subscription" }))
    const planning = yield* budget.reserve("opencode", JSON.stringify({ model: "jev-1.13", state: { userMessage: "Make a focused edit" }, questions: {} }))
    return { subscription, planning }
  }))
  expect(evidence.subscription.outputTokens).toBeNull()
  expect(evidence.subscription.reservedUsd).toBeNull()
  expect(evidence.planning.outputTokens).toBeNull()
  expect(evidence.planning.reservedUsd).toBeGreaterThan(0)
  expect(evidence.planning.sourceUrl).toBe(JEV_PRICE.sourceUrl)
})

test("Gateway Jev reserves exact verified input pricing from its header without changing request bytes", async () => {
  const body = JSON.stringify({ state: { userMessage: "Make a focused edit" }, questions: {} })
  const evidence = await Effect.runPromise(Effect.gen(function* () {
    const budget = yield* makeSmithBudget(limits, [VERCEL_JEV_PRICE])
    const planning = yield* budget.reserve("vercel", body, Option.some("typesafe-ai/jev"))
    const missingModel = yield* Effect.result(budget.reserve("vercel", body))
    const unknownModel = yield* Effect.result(budget.reserve("vercel", body, Option.some("typesafe-ai/unverified")))
    const mismatch = yield* Effect.result(budget.reserve("vercel", JSON.stringify({ model: "typesafe-ai/other", state: {} }), Option.some("typesafe-ai/jev")))
    return { planning, missingModel, unknownModel, mismatch, summary: yield* budget.summary }
  }))
  expect(evidence.planning.selector).toBe(VERCEL_JEV_PRICE.selector)
  expect(evidence.planning.inputBytes).toBe(new TextEncoder().encode(body).length)
  expect(evidence.planning.reservedUsd).toBe(new TextEncoder().encode(body).length * 0.042 / 1_000_000)
  expect(evidence.planning.outputTokens).toBeNull()
  expect(evidence.planning.sourceUrl).toBe("https://ai-gateway.vercel.sh/v1/models")
  expect([evidence.missingModel, evidence.unknownModel, evidence.mismatch].every(Result.isFailure)).toBe(true)
  expect(evidence.summary.requests).toBe(1)
})
