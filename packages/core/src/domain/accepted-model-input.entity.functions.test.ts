import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { Response } from "effect/ai"
import { AcceptedModelInput } from "./accepted-model-input.entity.js"
import { acceptedModelInputOf } from "./accepted-model-input.entity.functions.js"
import { stampResponseModel } from "./engine-stamp.entity.functions.js"
import { parseModelSelection } from "./model-selection.entity.functions.js"
import { extractUsage } from "../internal/mapping.entity.functions.js"

const sdkUsage = (inputTokens: Response.Usage["inputTokens"], output = 2) => new Response.Usage({ inputTokens, outputTokens: { total: output } })
const finish = (usage: Response.Usage) => Response.makePart("finish", { reason: "stop", usage })
const stamped = (usage: Response.Usage) => stampResponseModel([finish(usage)], "backup:actual:model")

describe("accepted model input", () => {
  test("retains full input with cached shares already included and the actual routed model", () => {
    const usage = sdkUsage({ total: 150, uncached: 100, cacheRead: 30, cacheWrite: 20 })
    expect(acceptedModelInputOf(usage, stamped(usage))).toEqual({ model: parseModelSelection("backup:actual:model"), inputTokens: Option.some(150) })
  })

  test("uses the selected usage snapshot without summing, reusing or filling counters from another snapshot", () => {
    const first = sdkUsage({ total: 300, cacheRead: 20 })
    const last = sdkUsage({ total: 120, cacheRead: 50 })
    const parts = [finish(first), finish(last)]
    expect(acceptedModelInputOf(last, parts).inputTokens).toEqual(Option.some(120))
    expect(acceptedModelInputOf(undefined, parts).inputTokens).toEqual(Option.some(120))
    expect(acceptedModelInputOf(sdkUsage({ total: 0 }), parts).inputTokens).toEqual(Option.none())
    expect(acceptedModelInputOf(sdkUsage({}), parts).inputTokens).toEqual(Option.none())
    expect(acceptedModelInputOf(undefined, [...parts, finish(sdkUsage({}))]).inputTokens).toEqual(Option.none())
  })

  test("can read a finish-only response and reports missing or invalid neutral model identity independently", () => {
    const usage = sdkUsage({ total: 15 })
    expect(acceptedModelInputOf(undefined, stamped(usage))).toEqual({ model: parseModelSelection("backup:actual:model"), inputTokens: Option.some(15) })
    expect(acceptedModelInputOf(usage, [finish(usage)]).model).toEqual(Option.none())
    expect(acceptedModelInputOf(usage, stampResponseModel([finish(usage)], "missing-colon")).model).toEqual(Option.none())
    expect(acceptedModelInputOf(undefined, []).inputTokens).toEqual(Option.none())
  })

  test("rejects unsupported usage and nonpositive, fractional, unsafe or inconsistent input evidence", () => {
    const invalid: ReadonlyArray<unknown> = [undefined, null, {}, { inputTokens: { total: 5 } },
      ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((total) => ({ inputTokens: { total }, outputTokens: {} })),
      { inputTokens: { total: 30, cacheRead: 20, cacheWrite: 11 }, outputTokens: {} },
      { inputTokens: { total: 30, cacheRead: -1 }, outputTokens: {} },
      { inputTokens: { total: 30, cacheWrite: Number.MAX_SAFE_INTEGER + 1 }, outputTokens: {} },
    ]
    expect(invalid.map((usage) => acceptedModelInputOf(usage, []).inputTokens)).toEqual(invalid.map(() => Option.none()))
    const cacheOnly = sdkUsage({ total: 0, cacheRead: 40, cacheWrite: 10 })
    expect(extractUsage(cacheOnly, []).inputTokens).toBe(50)
    expect(acceptedModelInputOf(cacheOnly, []).inputTokens).toEqual(Option.none())
  })

  test("encodes absence as null and enforces a positive safe integral input in the schema", () => {
    const decode = Schema.decodeUnknownOption(AcceptedModelInput)
    expect(decode({ model: null, inputTokens: 10 })).toEqual(Option.some({ model: Option.none(), inputTokens: Option.some(10) }))
    expect([0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1].map((inputTokens) => Option.isNone(decode({ model: null, inputTokens })))).toEqual([true, true, true, true, true])
    expect(decode({ model: null, inputTokens: null })).toEqual(Option.some({ model: Option.none(), inputTokens: Option.none() }))
  })
})
