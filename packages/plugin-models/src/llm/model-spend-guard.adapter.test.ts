import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Option } from "effect"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"
import { costOf, CurrentTurnRunId, harnessCodeOf, ModelId, ModelSelection, ModelSpend, ModelSpendMemoryLive, modelSpendExceededOf, ProviderId, RunId, tokenUsage } from "@xandreed/core"
import type { ModelPrice } from "@xandreed/core"
import { modelRetryDefaults } from "./model-retry-policy.entity.js"
import { CurrentModelRetryPolicy } from "../ports/model-retry-policy.port.js"
import { CurrentModelCallSelection } from "../ports/model-call-completion.port.js"
import { CurrentModelSpendGuard } from "../ports/model-spend-guard.port.js"
import type { ModelSpendOptions } from "./model-spend.entity.js"
import { worstCaseCost } from "./model-spend.entity.functions.js"
import { completeModelAttempt, observeModelBody } from "./model-completion.adapter.js"
import { resilientRequest } from "../transport/resilient-http-client.adapter.js"

/*
 * The spend guard on the request engine: every physical send, retries
 * included, reserves its worst case in the ledger before it goes out, and
 * each attempt's end settles or releases what it held.
 */

const policy = { ...modelRetryDefaults, requestTimeoutMs: 500, bodyIdleTimeoutMs: 500, totalTimeoutMs: 5000, backoff: { initialMs: 0, maxMs: 0, jitter: 0 } }
const price: ModelPrice = { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2.5 }
const selection = new ModelSelection({ provider: ProviderId.make("fixture"), modelId: ModelId.make("m") })
const runId = RunId.make("spend-guard-run")
const body = { model: "m", max_tokens: 100, messages: [{ role: "user", content: "hello" }] }
const request = HttpClientRequest.post("https://fixture.invalid/chat").pipe(HttpClientRequest.bodyJsonUnsafe(body))
const worst = worstCaseCost(new TextEncoder().encode(JSON.stringify(body)).byteLength, 100, price)
const usage = { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 }
const ok = JSON.stringify({ choices: [], usage })
const options = (caps: Partial<Pick<ModelSpendOptions, "turnCap" | "totalCap">>, prices: Readonly<Record<string, ModelPrice>> = { "fixture:m": price }): ModelSpendOptions =>
  ({ prices, uncappedOutputTokens: 32_000, inputBytesPerToken: 1, ...caps })

/**
 * A ledger, a client answering `statuses` in turn, and what the ledger
 * reserved for the turn as each send went out. `meanwhile` runs on the
 * ledger as the first send goes out (another turn's spend).
 */
const guarded = (statuses: ReadonlyArray<number>, guardOptions: ModelSpendOptions, meanwhile: (ledger: ModelSpend["Service"]) => Effect.Effect<unknown, unknown> = () => Effect.void) => Effect.gen(function* () {
  const ledger = yield* Effect.service(ModelSpend).pipe(Effect.provide(ModelSpendMemoryLive))
  const reservedAtSend: Array<number> = []
  const client = HttpClient.make((sent) => Effect.gen(function* () {
    reservedAtSend.push((yield* Effect.orDie(ledger.totals(Option.some(runId)))).reserved)
    if (reservedAtSend.length === 1) yield* Effect.orDie(meanwhile(ledger))
    const status = statuses[reservedAtSend.length - 1] ?? 200
    return HttpClientResponse.fromWeb(sent, new Response(status === 200 ? ok : JSON.stringify({ error: { message: "slow down" } }), { status }))
  }))
  const send = resilientRequest(client, request, { protocol: "compat" }).pipe(
    Effect.tap((response) => response.text.pipe(
      Effect.flatMap((text) => observeModelBody(response.modelAttempt.completion, text, true)),
      Effect.andThen(completeModelAttempt(response.modelAttempt.completion, { _tag: "Completed" })),
    )),
    Effect.provideService(CurrentModelSpendGuard, Option.some({ ledger, options: guardOptions })),
    Effect.provideService(CurrentModelCallSelection, Option.some(selection)),
    Effect.provideService(CurrentTurnRunId, Option.some(runId)),
    Effect.provideService(CurrentModelRetryPolicy, policy),
  )
  return { ledger, reservedAtSend, send }
})

/** A send through a client that answers with `answer`, guarded by `ledger` within no cap, under `retry`. */
const sendWith = (ledger: ModelSpend["Service"], answer: (sent: HttpClientRequest.HttpClientRequest) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>, retry = policy) =>
  resilientRequest(HttpClient.make(answer), request, { protocol: "compat" }).pipe(
    Effect.provideService(CurrentModelSpendGuard, Option.some({ ledger, options: options({}) })),
    Effect.provideService(CurrentModelCallSelection, Option.some(selection)),
    Effect.provideService(CurrentTurnRunId, Option.some(runId)),
    Effect.provideService(CurrentModelRetryPolicy, retry),
  )
const memoryLedger = Effect.service(ModelSpend).pipe(Effect.provide(ModelSpendMemoryLive))
const transportFailure = (sent: HttpClientRequest.HttpClientRequest, cause: unknown) =>
  Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request: sent, cause }) }))

describe("the spend guard on physical sends", () => {
  test("each send, a retry included, reserves its worst case; a refused attempt without usage releases it, the accepted one settles at its usage's cost", async () => {
    const observed = await Effect.runPromise(Effect.gen(function* () {
      const { ledger, reservedAtSend, send } = yield* guarded([429, 200], options({ turnCap: 10 * worst }))
      yield* send
      return { reservedAtSend, turn: yield* ledger.totals(Option.some(runId)), total: yield* ledger.totals(Option.none()) }
    }))
    const settled = costOf(tokenUsage({ inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens }), price)
    expect(observed.reservedAtSend).toEqual([worst, worst])
    expect(observed.turn).toEqual({ settled, reserved: 0 })
    expect(observed.total).toEqual({ settled, reserved: 0 })
  })

  test("a send whose worst case passes the turn's cap is refused before it goes out", async () => {
    const observed = await Effect.runPromise(Effect.gen(function* () {
      const { ledger, reservedAtSend, send } = yield* guarded([200], options({ turnCap: worst / 2 }))
      const error = yield* Effect.flip(send)
      return { error, reservedAtSend, turn: yield* ledger.totals(Option.some(runId)) }
    }))
    expect(observed.reservedAtSend).toEqual([])
    expect(harnessCodeOf(observed.error)).toEqual(Option.some("model.spend"))
    expect(Option.map(modelSpendExceededOf(observed.error), (refusal) => [refusal.reason, refusal.cap, refusal.committed, refusal.requested])).toEqual(Option.some(["turn", worst / 2, 0, worst]))
    expect(observed.turn).toEqual({ settled: 0, reserved: 0 })
  })

  test("a retry whose worst case no longer fits the total cap is refused, the refused attempt's hold released", async () => {
    const observed = await Effect.runPromise(Effect.gen(function* () {
      const other = RunId.make("spend-guard-other-run")
      const { ledger, reservedAtSend, send } = yield* guarded([429, 200], options({ totalCap: 1.5 * worst }), (ledger) => ledger.reserve({ runId: other, amount: 0.75 * worst, caps: {} }))
      const error = yield* Effect.flip(send)
      return { error, reservedAtSend, turn: yield* ledger.totals(Option.some(runId)), total: yield* ledger.totals(Option.none()) }
    }))
    expect(observed.reservedAtSend).toEqual([worst])
    expect(Option.map(modelSpendExceededOf(observed.error), (refusal) => [refusal.reason, refusal.committed, refusal.requested])).toEqual(Option.some(["total", 0.75 * worst, worst]))
    expect(observed.turn).toEqual({ settled: 0, reserved: 0 })
    expect(observed.total).toEqual({ settled: 0, reserved: 0.75 * worst })
  })

  test("a model the prices leave out is refused before anything is sent", async () => {
    const observed = await Effect.runPromise(Effect.gen(function* () {
      const { reservedAtSend, send } = yield* guarded([200], options({}, { "fixture:other": price }))
      return { error: yield* Effect.flip(send), reservedAtSend }
    }))
    expect(observed.reservedAtSend).toEqual([])
    expect(harnessCodeOf(observed.error)).toEqual(Option.some("model.unpriced"))
  })

  test("an interruption that lands while the ledger takes a hold leaves nothing held: the hold reaches the attempt, which releases it unsent", async () => {
    const observed = await Effect.runPromise(Effect.gen(function* () {
      const inner = yield* memoryLedger
      const taken = yield* Deferred.make<void>()
      const answer = yield* Deferred.make<void>()
      // A ledger whose reply is still on its way once it has taken the hold, as a shared store's would be.
      const slow = ModelSpend.of({ ...inner, reserve: (asked) => inner.reserve(asked).pipe(Effect.tap(() => Deferred.succeed(taken, undefined)), Effect.tap(() => Deferred.await(answer))) })
      const sends: Array<number> = []
      const fiber = yield* Effect.forkChild(sendWith(slow, (sent) => Effect.sync(() => sends.push(1)).pipe(Effect.as(HttpClientResponse.fromWeb(sent, new Response(ok, { status: 200 }))))))
      yield* Deferred.await(taken)
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber), { startImmediately: true })
      yield* Deferred.succeed(answer, undefined)
      yield* Fiber.join(interrupting)
      return { sends: sends.length, turn: yield* inner.totals(Option.some(runId)), total: yield* inner.totals(Option.none()) }
    }))
    expect(observed.sends).toBe(0)
    expect(observed.turn).toEqual({ settled: 0, reserved: 0 })
    expect(observed.total).toEqual({ settled: 0, reserved: 0 })
  })

  test("a connection that never opened releases its hold; one lost after the request went out settles at the hold", async () => {
    const observed = await Effect.runPromise(Effect.gen(function* () {
      const refused = yield* memoryLedger
      yield* Effect.flip(sendWith(refused, (sent) => transportFailure(sent, new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } })), { ...policy, maxAttempts: 1 }))
      const reset = yield* memoryLedger
      yield* Effect.flip(sendWith(reset, (sent) => transportFailure(sent, new TypeError("fetch failed", { cause: { code: "ECONNRESET" } })), { ...policy, maxAttempts: 1 }))
      return { refused: yield* refused.totals(Option.none()), reset: yield* reset.totals(Option.none()) }
    }))
    expect(observed.refused).toEqual({ settled: 0, reserved: 0 })
    expect(observed.reset).toEqual({ settled: worst, reserved: 0 })
  })

  test("a send whose reply did not come before the call's deadline settles at the hold: the provider may have generated and billed it", async () => {
    const observed = await Effect.runPromise(Effect.gen(function* () {
      const ledger = yield* memoryLedger
      const error = yield* Effect.flip(sendWith(ledger, () => Effect.never, { ...policy, totalTimeoutMs: 50 }))
      return { error, total: yield* ledger.totals(Option.none()) }
    }))
    expect(observed.total).toEqual({ settled: worst, reserved: 0 })
  })

  test("a gateway's timeout status settles at the hold; another error status releases it", async () => {
    const observed = await Effect.runPromise(Effect.gen(function* () {
      const gateway = yield* memoryLedger
      yield* Effect.flip(sendWith(gateway, (sent) => Effect.succeed(HttpClientResponse.fromWeb(sent, new Response("upstream timed out", { status: 504 }))), { ...policy, maxAttempts: 1 }))
      const overloaded = yield* memoryLedger
      yield* Effect.flip(sendWith(overloaded, (sent) => Effect.succeed(HttpClientResponse.fromWeb(sent, new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503 }))), { ...policy, maxAttempts: 1 }))
      return { gateway: yield* gateway.totals(Option.none()), overloaded: yield* overloaded.totals(Option.none()) }
    }))
    expect(observed.gateway).toEqual({ settled: worst, reserved: 0 })
    expect(observed.overloaded).toEqual({ settled: 0, reserved: 0 })
  })
})
