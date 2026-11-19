import { describe, expect, test } from "bun:test"
import { Option, Result } from "effect"
import { AiError } from "effect/ai"
import { ModelSpendExceeded } from "@xandreed/core/kernel"
import { chargeOf, costOf, isRefusalStatus, isSpendRefusal, metredCostOf, neverConnected, settlementOf, spendRefusalOf, spendRefused, unchargeable, worstCaseOf } from "./model-spend.entity.functions.js"
import type { Charge, Reported } from "./model-spend.entity.js"

const price = { input: 2, output: 10, cacheRead: 0.5, cacheWrite: 4, maxOutput: 1000 }
const held: Charge = { _tag: "Held", amount: 0.03, price }
const used = (input: number, output: number, cacheRead = 0, cacheWrite = 0, billed?: number): Reported => ({ input, output, cacheRead, cacheWrite, billed })

describe("what a call holds", () => {
  test("its worst case: every input token at the dearest input price, every output token at the output price", () => {
    expect(worstCaseOf(price, 1_000, 1_000)).toBe((1_000 * 4 + 1_000 * 10) / 1_000_000)
    expect(worstCaseOf({ input: 1, output: 3 }, 2_000_000, 0)).toBe(2)
  })

  test("from the body's bytes and the output bound, at the model's price; a model the host marked uncapped holds nothing", () => {
    const options = { prices: { m: price }, uncapped: ["free"], bytesPerToken: 2 }
    expect(chargeOf(options, "m", 4_000, Option.some(500))).toEqual(Result.succeed({ _tag: "Held", price, amount: worstCaseOf(price, 2_000, 500) }))
    expect(chargeOf(options, "free", 4_000, Option.none())).toEqual(Result.succeed({ _tag: "Unheld" }))
  })

  test("a model with no price is refused, and so is a priced call with no output bound", () => {
    expect(chargeOf({ prices: {} }, "m", 10, Option.some(5))).toEqual(Result.fail("unpriced"))
    expect(chargeOf({ prices: { m: { input: 1, output: 1 } } }, "m", 10, Option.none())).toEqual(Result.fail("unbounded"))
  })
})

describe("what a call costs", () => {
  test("the uncached input, the cache's reads and writes at their own prices, the output at its own", () => {
    expect(costOf(used(1_000, 100, 600, 200), price)).toBe((200 * 2 + 600 * 0.5 + 200 * 4 + 100 * 10) / 1_000_000)
    expect(costOf(used(1_000, 0, 1_000), { input: 3, output: 1 })).toBe(0.003)
  })
})

describe("how a hold is closed, as a table", () => {
  test("what was reported settles it; with nothing reported, a request that left settles at the hold, and one that never left or was refused releases", () => {
    const rows = [
      ["reported usage", settlementOf(held, Option.some(used(1_000, 100)), "Sent")],
      ["reported usage, refused", settlementOf(held, Option.some(used(10, 0)), "Refused")],
      ["the provider's bill", settlementOf(held, Option.some(used(1_000, 100, 0, 0, 0.0005)), "Sent")],
      ["sent, nothing reported (a cut, an interruption, a timeout, a 5xx)", settlementOf(held, Option.none(), "Sent")],
      ["refused before generating (a 4xx)", settlementOf(held, Option.none(), "Refused")],
      ["never left", settlementOf(held, Option.none(), "Unsent")],
      ["uncapped, billed", settlementOf({ _tag: "Unheld" }, Option.some(used(1, 1, 0, 0, 0.0007)), "Sent")],
      ["uncapped, usage alone", settlementOf({ _tag: "Unheld" }, Option.some(used(1, 1)), "Sent")],
      ["uncapped, cut", settlementOf({ _tag: "Unheld" }, Option.none(), "Sent")],
    ] as const
    expect(rows.map(([name, settled]) => [name, Option.getOrElse(Option.map(settled, (cost) => `settle ${cost}`), () => "release")])).toEqual([
      ["reported usage", `settle ${(1_000 * 2 + 100 * 10) / 1_000_000}`],
      ["reported usage, refused", `settle ${(10 * 2) / 1_000_000}`],
      ["the provider's bill", "settle 0.0005"],
      ["sent, nothing reported (a cut, an interruption, a timeout, a 5xx)", "settle 0.03"],
      ["refused before generating (a 4xx)", "release"],
      ["never left", "release"],
      ["uncapped, billed", "settle 0.0007"],
      ["uncapped, usage alone", "settle 0"],
      ["uncapped, cut", "settle 0"],
    ])
  })

  test("what the cost metric counts: what a held call settled at, or an uncapped call's bill; never the 0 an unpriced call settles at", () => {
    const rows = [
      ["reported usage", metredCostOf(held, Option.some(used(1_000, 100)), "Sent")],
      ["the provider's bill", metredCostOf(held, Option.some(used(1_000, 100, 0, 0, 0.0005)), "Sent")],
      ["sent, nothing reported", metredCostOf(held, Option.none(), "Sent")],
      ["never left", metredCostOf(held, Option.none(), "Unsent")],
      ["uncapped, billed", metredCostOf({ _tag: "Unheld" }, Option.some(used(1, 1, 0, 0, 0.0007)), "Sent")],
      ["uncapped, usage alone", metredCostOf({ _tag: "Unheld" }, Option.some(used(1, 1)), "Sent")],
      ["uncapped, cut", metredCostOf({ _tag: "Unheld" }, Option.none(), "Sent")],
    ] as const
    expect(rows.map(([name, cost]) => [name, Option.getOrElse(Option.map(cost, (amount) => `count ${amount}`), () => "nothing")])).toEqual([
      ["reported usage", `count ${(1_000 * 2 + 100 * 10) / 1_000_000}`],
      ["the provider's bill", "count 0.0005"],
      ["sent, nothing reported", "count 0.03"],
      ["never left", "nothing"],
      ["uncapped, billed", "count 0.0007"],
      ["uncapped, usage alone", "nothing"],
      ["uncapped, cut", "nothing"],
    ])
  })

  test("a refusal status is a 4xx but 408; a 5xx and a timeout are not", () => {
    expect([400, 401, 402, 403, 404, 408, 422, 429, 500, 503, 504].filter(isRefusalStatus)).toEqual([400, 401, 402, 403, 404, 422, 429])
  })

  test("a connection that never opened is told by its code, on the error or on its cause, on Node and on Bun", () => {
    const node = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }) })
    const bun = Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" })
    const reset = new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) })
    expect([neverConnected(node), neverConnected(bun), neverConnected(reset), neverConnected("text")]).toEqual([true, true, false, false])
  })
})

describe("a spend refusal", () => {
  const refusal = new ModelSpendExceeded({ reason: "total", cap: 0.05, committed: 0.04, requested: 0.02, message: "the total model spend cap of 0.05 would be passed" })

  test("is a non-retryable AiError in the ledger's words, and the guard reads the ledger's refusal back from it", () => {
    const error = spendRefused(refusal, "OpenAiCompatible", "streamText")
    expect([error.isRetryable, error.message]).toEqual([false, "OpenAiCompatible.streamText: Invalid request. the total model spend cap of 0.05 would be passed"])
    expect(isSpendRefusal(error)).toBe(true)
    const back = Option.getOrThrow(spendRefusalOf(error))
    expect([back._tag, back.reason, back.cap, back.committed, back.requested, back.message]).toEqual(["ModelSpendExceeded", "total", 0.05, 0.04, 0.02, refusal.message])
  })

  test("is told apart from every other failure, a refusal for want of a price among them", () => {
    const others = [
      unchargeable("unpriced", "m", "OpenAiCompatible", "streamText"),
      AiError.make({ module: "m", method: "streamText", reason: new AiError.InvalidRequestError({ description: "bad" }) }),
      AiError.make({ module: "m", method: "streamText", reason: new AiError.RateLimitError({}) }),
      refusal,
      new Error("no"),
    ]
    expect(others.map(isSpendRefusal)).toEqual([false, false, false, false, false])
  })
})
