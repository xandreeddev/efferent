// An evaluation run's budget over a real model provider of the kernel's: the runnable builds
// `openAiCompatibleModel` inside its `execute`, so the layer takes the trial's account the run provides as
// `ModelSpend`, and every call it sends is held and settled there. The provider talks to a fake `fetch` shaped like
// the gateway's stream; no network. A provider built once for the whole run, outside the trials, would take
// whatever ledger was in context when it was built, and the run's budget would cap none of its calls.
import { expect, test } from "bun:test"
import { Effect, Layer, Option, Ref, Redacted } from "effect"
import { LanguageModel } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import { isSpendRefusal, openAiCompatibleModel } from "@xandreed/sdk/kernel/node"
import { EvaluationError, EvaluationRunStore, EvaluationServicesLive, runEvaluation } from "../index.js"
import type { EvaluationApp } from "../index.js"
import { fixture } from "./fixture.testing.js"

const MODEL = "provider/model"
/** USD per million tokens: every answer below costs 1,000 × 1 + 500 × 2, so 0.002. */
const price = { input: 1, output: 2 }
const COST = (1_000 * 1 + 500 * 2) / 1_000_000

/** A gateway that answers every request the same way, reporting 1,000 tokens in and 500 out, and counts the requests. */
const gateway = () => {
  let sent = 0
  const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
  const fetch = Object.assign(async () => {
    sent++
    return new Response(`${chunk({ choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] })}${chunk({ choices: [], usage: { prompt_tokens: 1_000, completion_tokens: 500 } })}data: [DONE]\n\n`, { status: 200 })
  }, { preconnect: () => {} })
  return { fetch, sent: () => sent }
}

/**
 * The app: one task, four samples, one at a time. Its runnable builds the provider in the trial (so its layer is
 * given the trial's account) and asks one question; a failure is kept as it came, then made the trial's failure.
 */
const appOver = (fetch: ReturnType<typeof gateway>["fetch"], failures: Ref.Ref<ReadonlyArray<unknown>>): EvaluationApp => fixture(() =>
  LanguageModel.generateText({ prompt: "question" }).pipe(
    Effect.map((response) => ({ output: response.text, evidence: { facts: ["source"] } })),
    Effect.provide(openAiCompatibleModel({ model: MODEL, baseUrl: "https://gateway.test/v1", apiKey: Redacted.make("k"), maxOutputTokens: 1_000, spend: { prices: { [MODEL]: price } } })),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
    Effect.tapError((error) => Ref.update(failures, (all) => [...all, error])),
    Effect.mapError((error) => new EvaluationError({ code: "provider", message: error.message, cause: error })),
  ))

test("a run's budget caps what a kernel provider sends: the call over it is refused before it is sent, and the run stops starting trials", async () => {
  const { fetch, sent } = gateway()
  const outcome = await Effect.runPromise(Effect.gen(function* () {
    const failures = yield* Ref.make<ReadonlyArray<unknown>>([])
    const app = appOver(fetch, failures)
    const store = Layer.succeed(EvaluationRunStore, { writeTrial: () => Effect.void, appendTranscript: () => Effect.void, writeRun: () => Effect.void })
    // Each call holds its body's bytes and 1,000 output tokens at the price, a little over 0.002, and settles at
    // 0.002: two fit under 0.005, the third's hold does not.
    const run = yield* runEvaluation(app, "run", { ids: ["suite"], split: "validation", repetitions: 4, spendBudget: 0.005 }).pipe(
      Effect.provide(Layer.merge(EvaluationServicesLive(app), store)),
    )
    return { run, failures: yield* Ref.get(failures) }
  }))
  expect(outcome.run.trials.map((trial) => trial.status)).toEqual(["completed", "completed", "skipped", "skipped"])
  expect(outcome.run.trials[2]!.reason).toStartWith("budget: the total model spend cap of 0.005 would be passed")
  expect(outcome.run.trials[3]!.reason).toStartWith("budget: not run")
  // The refused call failed with the ledger's refusal, told apart by the provider's guard, and was never sent.
  expect(outcome.failures.map(isSpendRefusal)).toEqual([true])
  expect(sent()).toBe(2)
  // What the run and each trial settled is what the provider reported, at the price: nothing of the refused hold.
  expect(outcome.run.spend).toEqual({ budget: Option.some(0.005), settled: 2 * COST })
  expect(outcome.run.trials.map((trial) => trial.spend?.settled)).toEqual([COST, COST, 0, undefined])
  expect(outcome.run.failures).toEqual([])
})
