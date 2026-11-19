// A host's model, as `docs/kernel.md` shows it: the gateway's model, its key from the host's configuration, every
// call charging one ledger capped at five cents. Run here over a fake `fetch` shaped like the gateway's stream.
import { describe, expect, test } from "bun:test"
import { Config, ConfigProvider, Effect, Layer } from "effect"
import { LanguageModel } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import { ModelSpend, modelSpendMemory } from "@xandreed/core/kernel"
import { isSpendRefusal, openAiCompatibleModel } from "./index.js"

// #region gateway
const DEEPSEEK = "deepseek/deepseek-v4.1-flash-1017"

/**
 * DeepSeek V4.1 Flash through the Vercel AI Gateway, asked of Baseten first. The key is the host's configuration's,
 * read as a secret (`Config.Redacted`), never written in the code. Each call holds its worst case (its request's
 * size and its 1,024 tokens of output, at the price given) in the ledger before it is sent, and is settled at what
 * the gateway billed.
 */
const gateway = Layer.unwrap(Effect.map(Config.Redacted("VERCEL_API_KEY"), (apiKey) => openAiCompatibleModel({
  model: DEEPSEEK,
  baseUrl: "https://ai-gateway.vercel.sh/v1",
  apiKey,
  maxOutputTokens: 1024,
  extra: { providerOptions: { gateway: { order: ["baseten"] } } },
  spend: { prices: { [DEEPSEEK]: { input: 0.3, output: 1.2, cacheRead: 0.007 } }, caps: { total: 0.05 } },
})))

/** One ledger for every call of the program: what they cost together stays under five cents. */
const stack = gateway.pipe(Layer.provideMerge(modelSpendMemory))

/** A question answered; a call the cap refused is told apart from every other failure. */
const ask = (question: string) => LanguageModel.generateText({ prompt: question }).pipe(
  Effect.map((response) => response.text),
  Effect.catchIf(isSpendRefusal, () => Effect.succeed("The budget is spent.")),
)

const twoQuestions = Effect.gen(function* () {
  const first = yield* ask("What does a ledger do?")
  const second = yield* ask("And a budget?")
  return { first, second, totals: yield* (yield* ModelSpend).totals }
}).pipe(Effect.provide(stack))
// #endregion gateway

/** A gateway that answers once, billing `cost`, and counts the requests it was sent. */
const gatewayBilling = (cost: number) => {
  let sent = 0
  const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
  const fetch = Object.assign(async () => {
    sent++
    return new Response(`${chunk({ choices: [{ delta: { content: "It keeps what was spent." }, finish_reason: "stop" }] })}${chunk({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 6, cost } })}data: [DONE]\n\n`, { status: 200 })
  }, { preconnect: () => {} })
  return { fetch, sent: () => sent }
}
const configured = ConfigProvider.fromEnv({ env: { VERCEL_API_KEY: "test-key" } })

describe("a host's model through the gateway", () => {
  test("answers, and settles each call at what the gateway billed", async () => {
    const gate = gatewayBilling(0.0001)
    const run = await Effect.runPromise(twoQuestions.pipe(Effect.provideService(ConfigProvider.ConfigProvider, configured), Effect.provideService(FetchHttpClient.Fetch, gate.fetch)))
    expect(run).toEqual({ first: "It keeps what was spent.", second: "It keeps what was spent.", totals: { settled: 0.0002, reserved: 0 } })
    expect(gate.sent()).toBe(2)
  })

  test("once the ledger is near its cap, the next call is refused before it is sent, and the program says so", async () => {
    const gate = gatewayBilling(0.0495)
    const run = await Effect.runPromise(twoQuestions.pipe(Effect.provideService(ConfigProvider.ConfigProvider, configured), Effect.provideService(FetchHttpClient.Fetch, gate.fetch)))
    expect(run).toEqual({ first: "It keeps what was spent.", second: "The budget is spent.", totals: { settled: 0.0495, reserved: 0 } })
    expect(gate.sent()).toBe(1)
  })
})
