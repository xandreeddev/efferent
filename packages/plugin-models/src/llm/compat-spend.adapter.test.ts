import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Option, Schema, Stream } from "effect"
import { costOf, CurrentTurnRunId, harnessCodeOf, ModelSpend, ModelSpendMemoryLive, modelSpendExceededOf, RunId, tokenUsage } from "@xandreed/core"
import type { ModelPrice } from "@xandreed/core"
import type { ModelsFetch } from "../ports/models-transport.port.js"
import { CurrentModelRetryPolicy } from "../ports/model-retry-policy.port.js"
import { CurrentModelSpendGuard } from "../ports/model-spend-guard.port.js"
import { scriptedChatCompletions } from "../transport/scripted-chat.adapter.js"
import { makeCompatLanguageModel } from "./compat.js"
import type { CompatConfig } from "./compat.js"
import { modelRetryDefaults } from "./model-retry-policy.entity.js"
import { ModelSpendOptions } from "./model-spend.entity.js"
import { worstCaseCost } from "./model-spend.entity.functions.js"

/*
 * A compat model the host builds itself, with `spend`: each physical send,
 * every retry included, reserves its worst case in the host's ledger for
 * the current turn before it goes out, and its attempt settles at what its
 * reported usage cost, a streamed one once its final usage is read; a send
 * past a cap is refused before it goes out. The endpoint is the scripted
 * one, so the production client reads the wire it would.
 */

const price: ModelPrice = { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2.5 }
const runId = RunId.make("compat-spend-run")
const usage = { promptTokens: 40, completionTokens: 10 }
const settledCost = costOf(tokenUsage({ inputTokens: usage.promptTokens, outputTokens: usage.completionTokens }), price)
const policy = { ...modelRetryDefaults, requestTimeoutMs: 500, bodyIdleTimeoutMs: 500, totalTimeoutMs: 5000, backoff: { initialMs: 0, maxMs: 0, jitter: 0 } }
const config: CompatConfig = { moduleName: "Fixture", chatUrl: "https://fixture.invalid/v1/chat/completions", model: "m", maxOutputTokens: 100 }

/** The worst case a sent body reserves: its bytes as input tokens, its `max_tokens` as output. */
const worstOf = (body: Schema.JsonObject) => worstCaseCost(new TextEncoder().encode(JSON.stringify(body)).byteLength, 100, price)

/**
 * A memory ledger, a scripted endpoint answering `text` with `usage`, a
 * fetch that records what the ledger held for the turn as each send went
 * out (`refuseFirst` sends answer 429 without reaching the script), and
 * the host's spend guard over the ledger within `caps`.
 */
const fixture = (caps: { readonly turnCap?: number; readonly totalCap?: number } = {}, refuseFirst = 0) => Effect.gen(function* () {
  const ledger = yield* Effect.service(ModelSpend).pipe(Effect.provide(ModelSpendMemoryLive))
  const heldDuringStream: Array<number> = []
  const endpoint = scriptedChatCompletions([{
    text: "settled", usage, repeat: true,
    beforeChunk: (chunk) => chunk === 0 ? ledger.totals(Option.some(runId)).pipe(Effect.orDie, Effect.map((totals) => { heldDuringStream.push(totals.reserved) })) : Effect.void,
  }])
  const heldAtSend: Array<number> = []
  const fetch: ModelsFetch = (input, init) => {
    heldAtSend.push(Effect.runSync(Effect.orDie(ledger.totals(Option.some(runId)))).reserved)
    return heldAtSend.length <= refuseFirst
      ? Promise.resolve(new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429 }))
      : endpoint.fetch(input, init)
  }
  // A host decodes its options as the plugin does, so the defaults apply.
  const options = yield* Schema.decodeUnknownEffect(ModelSpendOptions)({ prices: { "Fixture:m": price }, ...caps })
  const model = yield* makeCompatLanguageModel({ ...config, fetchImpl: fetch, spend: { ledger, options } })
  return { ledger, model, endpoint, heldAtSend, heldDuringStream }
})

const inTurn = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(
  Effect.provideService(CurrentTurnRunId, Option.some(runId)),
  Effect.provideService(CurrentModelRetryPolicy, policy),
)

describe("makeCompatLanguageModel with spend", () => {
  test("a buffered call reserves its worst case before the send and settles at its reported usage's cost", async () => {
    const observed = await Effect.runPromise(inTurn(Effect.gen(function* () {
      const { ledger, model, endpoint, heldAtSend } = yield* fixture({ turnCap: 1 })
      const response = yield* model.generateText({ prompt: "hello" })
      const requests = yield* endpoint.requests
      return { text: response.text, heldAtSend, requests, turn: yield* ledger.totals(Option.some(runId)), total: yield* ledger.totals(Option.none()) }
    })))
    expect(observed.text).toBe("settled")
    expect(observed.requests).toHaveLength(1)
    expect(observed.heldAtSend).toEqual([worstOf(observed.requests[0]!.body)])
    expect(observed.turn).toEqual({ settled: settledCost, reserved: 0 })
    expect(observed.total).toEqual({ settled: settledCost, reserved: 0 })
  })

  test("a streamed call holds its worst case while the reply streams and settles once its final usage is read", async () => {
    const observed = await Effect.runPromise(inTurn(Effect.gen(function* () {
      const { ledger, model, endpoint, heldAtSend, heldDuringStream } = yield* fixture({ turnCap: 1 })
      const parts = yield* Stream.runCollect(model.streamText({ prompt: "hello" }))
      const requests = yield* endpoint.requests
      return { parts, heldAtSend, heldDuringStream, requests, turn: yield* ledger.totals(Option.some(runId)) }
    })))
    const worst = worstOf(observed.requests[0]!.body)
    expect(observed.requests.map((request) => request.stream)).toEqual([true])
    expect(observed.parts.filter((part) => part.type === "text-delta").map((part) => part.delta).join("")).toBe("settled")
    expect(observed.heldAtSend).toEqual([worst])
    expect(observed.heldDuringStream).toEqual([worst])
    expect(observed.turn).toEqual({ settled: settledCost, reserved: 0 })
  })

  test("each retried send reserves again; the refused attempt without usage releases its hold, the answered one settles", async () => {
    const observed = await Effect.runPromise(inTurn(Effect.gen(function* () {
      const { ledger, model, endpoint, heldAtSend } = yield* fixture({}, 1)
      yield* model.generateText({ prompt: "hello" })
      const requests = yield* endpoint.requests
      return { heldAtSend, requests, turn: yield* ledger.totals(Option.some(runId)) }
    })))
    const worst = worstOf(observed.requests[0]!.body)
    expect(observed.requests).toHaveLength(1)
    // At each send the ledger holds that send's worst case alone: the refused attempt released its hold before the retry.
    expect(observed.heldAtSend).toEqual([worst, worst])
    expect(observed.turn).toEqual({ settled: settledCost, reserved: 0 })
  })

  test("a send whose worst case passes the turn's cap is refused before it goes out, the refusal carried to the turn", async () => {
    const observed = await Effect.runPromise(inTurn(Effect.gen(function* () {
      const { ledger, model, endpoint, heldAtSend } = yield* fixture({ turnCap: 0.000_001 })
      const exit = yield* Effect.exit(model.generateText({ prompt: "hello" }))
      return { exit, heldAtSend, requests: yield* endpoint.requests, turn: yield* ledger.totals(Option.some(runId)) }
    })))
    expect(observed.heldAtSend).toEqual([])
    expect(observed.requests).toEqual([])
    expect(observed.turn).toEqual({ settled: 0, reserved: 0 })
    expect(Exit.isFailure(observed.exit)).toBe(true)
    const refusal = Exit.isFailure(observed.exit) ? Cause.squash(observed.exit.cause) : undefined
    expect(harnessCodeOf(refusal)).toEqual(Option.some("model.spend"))
    expect(Option.map(modelSpendExceededOf(refusal), (exceeded) => [exceeded.reason, exceeded.cap])).toEqual(Option.some(["turn", 0.000_001]))
  })

  test("a model its prices leave out is refused with model.unpriced before anything is sent", async () => {
    const observed = await Effect.runPromise(inTurn(Effect.gen(function* () {
      const ledger = yield* Effect.service(ModelSpend).pipe(Effect.provide(ModelSpendMemoryLive))
      const endpoint = scriptedChatCompletions([{ text: "never", repeat: true }])
      const options = yield* Schema.decodeUnknownEffect(ModelSpendOptions)({ prices: { "Fixture:other": price } })
      const model = yield* makeCompatLanguageModel({ ...config, fetchImpl: endpoint.fetch, spend: { ledger, options } })
      const exit = yield* Effect.exit(model.generateText({ prompt: "hello" }))
      return { exit, requests: yield* endpoint.requests }
    })))
    expect(observed.requests).toEqual([])
    expect(harnessCodeOf(Exit.isFailure(observed.exit) ? Cause.squash(observed.exit.cause) : undefined)).toEqual(Option.some("model.unpriced"))
  })

  test("a call that runs under another spend guard still reserves and settles in the config's own: the other ledger is left untouched", async () => {
    const observed = await Effect.runPromise(inTurn(Effect.gen(function* () {
      const { ledger, model } = yield* fixture({})
      const other = yield* Effect.service(ModelSpend).pipe(Effect.provide(ModelSpendMemoryLive))
      // The other guard prices nothing: had it been used, the call would have been refused with model.unpriced.
      const options = yield* Schema.decodeUnknownEffect(ModelSpendOptions)({ prices: {} })
      yield* model.generateText({ prompt: "hello" }).pipe(Effect.provideService(CurrentModelSpendGuard, Option.some({ ledger: other, options })))
      return { own: yield* ledger.totals(Option.none()), other: yield* other.totals(Option.none()) }
    })))
    expect(observed.own).toEqual({ settled: settledCost, reserved: 0 })
    expect(observed.other).toEqual({ settled: 0, reserved: 0 })
  })
})
