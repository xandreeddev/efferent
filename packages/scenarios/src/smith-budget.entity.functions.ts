import { Effect, Option, Ref, Schema } from "effect"
import { SmithBudgetExceeded } from "./smith-budget.entity.js"
import type { ModelPrice, RequestReservation, SmithBudgetLimits } from "./smith-budget.entity.js"

const WireBudget = Schema.Struct({ model: Schema.optionalKey(Schema.NonEmptyString), max_tokens: Schema.optionalKey(Schema.Number), max_output_tokens: Schema.optionalKey(Schema.Number), max_completion_tokens: Schema.optionalKey(Schema.Number) })
/** An explicit subscription flag cannot turn an unpriced API model into a subscription. */
export const validateSmithCampaignModels = (main: string, fast: string, prices: ReadonlyArray<ModelPrice>) => {
  const subscription = main.startsWith("openai-codex:") && main.slice("openai-codex:".length).length > 0
  const priced = (selector: string) => prices.some((price) => price.selector === selector)
  return (!subscription && !priced(main)) || !priced(fast)
    ? Effect.fail(new SmithBudgetExceeded({ message: "Campaign models must have verified pricing; only openai-codex controllers may use separately admitted subscription usage" }))
    : Effect.succeed(subscription ? [main] : [])
}
export const makeSmithBudget = (limits: SmithBudgetLimits, prices: ReadonlyArray<ModelPrice>) => Effect.gen(function* () {
  const ledger = yield* Ref.make<ReadonlyArray<RequestReservation>>([])
  const reserve = (provider: string, body: string, headerModel: Option.Option<string> = Option.none()) => Effect.gen(function* () {
    const request = yield* Schema.decodeUnknownEffect(WireBudget)(yield* Effect.try({ try: () => JSON.parse(body), catch: () => new SmithBudgetExceeded({ message: "Refusing a non-JSON provider request" }) })).pipe(Effect.mapError(() => new SmithBudgetExceeded({ message: "Provider request has no model or supported token bound" })))
    if (request.model !== undefined && Option.exists(headerModel, (model) => model !== request.model)) return yield* Effect.fail(new SmithBudgetExceeded({ message: "Refusing conflicting body and header model selectors" }))
    const model = Option.orElse(Option.fromNullishOr(request.model), () => headerModel)
    if (Option.isNone(model) || model.value.length === 0) return yield* Effect.fail(new SmithBudgetExceeded({ message: "Refusing a provider request without a model selector" }))
    const selector = `${provider}:${model.value}`
    const price = Option.fromNullishOr(prices.find((entry) => entry.selector === selector))
    const subscription = Option.isNone(price) && limits.unpricedSelectors.includes(selector)
    const freeOutput = Option.isSome(price) && price.value.outputUsdPerMillion === 0
    const outputTokens = subscription || freeOutput ? null : request.max_output_tokens ?? request.max_completion_tokens ?? request.max_tokens
    const inputBytes = new TextEncoder().encode(body).length
    if (outputTokens === undefined || (outputTokens !== null && (outputTokens <= 0 || !Number.isInteger(outputTokens) || outputTokens > limits.maxOutputTokensPerRequest))) return yield* Effect.fail(new SmithBudgetExceeded({ message: `Refusing ${selector}: missing or excessive explicit output-token bound` }))
    if (inputBytes > limits.maxInputBytesPerRequest) return yield* Effect.fail(new SmithBudgetExceeded({ message: `Refusing ${selector}: input exceeds ${limits.maxInputBytesPerRequest} bytes` }))
    const reservedUsd = Option.match(price, { onNone: () => null, onSome: (value) => (inputBytes * value.inputUsdPerMillion + (outputTokens ?? 0) * value.outputUsdPerMillion) / 1_000_000 })
    if (Option.isNone(price) && !limits.unpricedSelectors.includes(selector)) return yield* Effect.fail(new SmithBudgetExceeded({ message: `Refusing ${selector}: neither priced nor explicitly admitted subscription usage` }))
    const reservation = { selector, inputBytes, outputTokens, reservedUsd, sourceUrl: Option.match(price, { onNone: () => null, onSome: (value) => value.sourceUrl }) }
    const admitted = yield* Ref.modify(ledger, (all) => {
      const priced = all.reduce((sum, value) => sum + (value.reservedUsd ?? 0), 0)
      const allowed = all.length < limits.maxRequests && priced + (reservedUsd ?? 0) <= limits.spendCapUsd && (reservedUsd !== null || all.filter((value) => value.reservedUsd === null).length < limits.maxUnpricedRequests)
      return [allowed, allowed ? [...all, reservation] : all] as const
    })
    return admitted ? reservation : yield* Effect.fail(new SmithBudgetExceeded({ message: "Campaign request/spend/subscription admission limit exhausted" }))
  })
  return { reserve, reservations: Ref.get(ledger), summary: Ref.get(ledger).pipe(Effect.map((all) => ({ requests: all.length, pricedReservedUsd: all.reduce((sum, entry) => sum + (entry.reservedUsd ?? 0), 0), unpricedRequests: all.filter((entry) => entry.reservedUsd === null).length, unpricedInputBytesBound: all.filter((entry) => entry.reservedUsd === null).reduce((sum, entry) => sum + entry.inputBytes, 0), unpricedOutputTokensBound: null }))) }
})
