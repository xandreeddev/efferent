import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { Option, Schema } from "effect"
import { costOf, ModelId, ModelSelection, ProviderId, tokenUsage } from "@xandreed/core"
import type { ModelCallUsage, ModelPrice } from "@xandreed/core"
import { ModelSpendOptions } from "./model-spend.entity.js"
import { inputTokenBound, neverConnected, reachOfStatus, requestOutputCapOf, spendPriceOf, spendSettlementOf, worstCaseCost } from "./model-spend.entity.functions.js"

const price: ModelPrice = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
const selection = new ModelSelection({ provider: ProviderId.make("fixture"), modelId: ModelId.make("m") })

describe("the spend option", () => {
  test("defaults the output reserved for an uncapped request and the bytes per input token; refuses an unknown key", () => {
    expect(Schema.decodeUnknownSync(ModelSpendOptions)({ prices: { "fixture:m": price }, turnCap: 1 })).toEqual({ prices: { "fixture:m": price }, turnCap: 1, uncappedOutputTokens: 32_000, inputBytesPerToken: 1 })
    expect(Option.isNone(Schema.decodeUnknownOption(ModelSpendOptions)({ prices: {}, perTurn: 1 }, { onExcessProperty: "error" }))).toBe(true)
    expect(Option.isNone(Schema.decodeUnknownOption(ModelSpendOptions)({ prices: {}, turnCap: -1 }))).toBe(true)
  })
})

describe("pricing a send", () => {
  test("a price is found by the call's provider and model; none for another model or no model", () => {
    expect(spendPriceOf({ "fixture:m": price }, Option.some(selection))).toEqual(Option.some(price))
    expect(spendPriceOf({ m: price }, Option.some(selection))).toEqual(Option.none())
    expect(spendPriceOf({ "fixture:m": price }, Option.none())).toEqual(Option.none())
  })

  test("a body's output cap is read under each protocol's name; none when it names none or is not JSON", () => {
    expect(requestOutputCapOf(JSON.stringify({ model: "m", max_tokens: 1024 }))).toEqual(Option.some(1024))
    expect(requestOutputCapOf(JSON.stringify({ max_completion_tokens: 50 }))).toEqual(Option.some(50))
    expect(requestOutputCapOf(JSON.stringify({ max_output_tokens: 70, max_tokens: null }))).toEqual(Option.some(70))
    expect(requestOutputCapOf(JSON.stringify({ messages: [] }))).toEqual(Option.none())
    expect(requestOutputCapOf("not json")).toEqual(Option.none())
  })

  test("the input bound is the body's bytes over the bytes per token, rounded up", () => {
    expect(inputTokenBound(1000, 1)).toBe(1000)
    expect(inputTokenBound(1000, 3)).toBe(334)
    expect(inputTokenBound(0, 4)).toBe(0)
  })

  test("no usage within the bounds costs more than the worst case", () => {
    const prices = fc.record({ input: fc.double({ min: 0, max: 100, noNaN: true }), output: fc.double({ min: 0, max: 100, noNaN: true }), cacheRead: fc.double({ min: 0, max: 100, noNaN: true }), cacheWrite: fc.double({ min: 0, max: 100, noNaN: true }), reasoning: fc.option(fc.double({ min: 0, max: 100, noNaN: true }), { nil: undefined }) })
    fc.assert(fc.property(prices, fc.nat(100_000), fc.nat(100_000), fc.nat(100_000), fc.nat(100_000), fc.nat(100_000), (drawn, input, cacheRead, cacheWrite, output, reasoning) => {
      const { reasoning: reasoningPrice, ...rest } = drawn
      const at: ModelPrice = reasoningPrice === undefined ? rest : { ...rest, reasoning: reasoningPrice }
      const usage = tokenUsage({ inputTokens: input + cacheRead + cacheWrite, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, outputTokens: output + reasoning, reasoningTokens: reasoning })
      return costOf(usage, at) <= worstCaseCost(usage.inputTokens, usage.outputTokens, at) * (1 + 1e-12)
    }))
  })
})

describe("settling an attempt", () => {
  const usage = tokenUsage({ inputTokens: 1000, outputTokens: 200 })
  const known: ModelCallUsage = { _tag: "Known", usage }
  const partial: ModelCallUsage = { _tag: "Partial", usage, reported: ["inputTokens"] }
  const unknown: ModelCallUsage = { _tag: "Unknown" }
  const cost = costOf(usage, price)

  test.each([
    { name: "known usage settles at its cost, sent", usage: known, reach: "Sent" as const, settles: Option.some(cost) },
    { name: "known usage settles at its cost, refused", usage: known, reach: "Refused" as const, settles: Option.some(cost) },
    { name: "a send that went out with part of its usage reported settles at least at the hold", usage: partial, reach: "Sent" as const, settles: Option.some(1) },
    { name: "a refused send settles at the part it reported", usage: partial, reach: "Refused" as const, settles: Option.some(cost) },
    { name: "a completed send without usage settles at the hold", usage: unknown, reach: "Sent" as const, settles: Option.some(1) },
    { name: "a send that timed out after it went out settles at the hold", usage: unknown, reach: "Sent" as const, settles: Option.some(1) },
    { name: "a stream cut before its usage chunk settles at the hold", usage: unknown, reach: "Sent" as const, settles: Option.some(1) },
    { name: "a send the provider refused with an error status releases its hold", usage: unknown, reach: "Refused" as const, settles: Option.none() },
    { name: "a send that never went out releases its hold", usage: unknown, reach: "Unsent" as const, settles: Option.none() },
  ])("$name", ({ usage, reach, settles }) => {
    expect(spendSettlementOf(usage, reach, 1, price)).toEqual(settles)
  })

  test("a partial report that already costs more than the hold settles at its cost", () => {
    expect(spendSettlementOf(partial, "Sent", cost / 2, price)).toEqual(Option.some(cost))
  })

  test("an error status shows a refusal, but a gateway's timeout, which shows the request may have been generated", () => {
    expect([400, 401, 413, 429, 500, 502, 503, 529].map(reachOfStatus)).toEqual(Array.from({ length: 8 }, () => "Refused"))
    expect([408, 504, 524].map(reachOfStatus)).toEqual(["Sent", "Sent", "Sent"])
  })

  test("a fetch whose connection never opened is told apart from one that failed after it went out", () => {
    expect(neverConnected({ code: "ConnectionRefused" })).toBe(true)
    expect(neverConnected(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }))).toBe(true)
    expect(neverConnected(new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } }))).toBe(true)
    expect(neverConnected(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }))).toBe(false)
    expect(neverConnected(new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET" } }))).toBe(false)
    expect(neverConnected(new Error("socket hang up"))).toBe(false)
    expect(neverConnected(undefined)).toBe(false)
  })
})
