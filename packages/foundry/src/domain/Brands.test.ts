import { describe, expect, test } from "bun:test"
import { Arbitrary, FastCheck, Schema } from "effect"
import { AttemptNumber, RuleId, Score } from "./Brands.js"

describe("Score", () => {
  test("accepts the closed interval 0..1", () => {
    expect(Number(Score.make(0))).toBe(0)
    expect(Number(Score.make(1))).toBe(1)
    expect(Number(Score.make(0.62))).toBeCloseTo(0.62)
  })

  test("rejects out-of-range values", () => {
    expect(Schema.is(Score)(1.01)).toBe(false)
    expect(Schema.is(Score)(-0.01)).toBe(false)
    expect(Schema.is(Score)(Number.NaN)).toBe(false)
  })

  test("arbitrary values round-trip decode∘encode", () => {
    const arb = Arbitrary.make(Score)
    FastCheck.assert(
      FastCheck.property(arb, (score) => {
        const encoded = Schema.encodeSync(Score)(score)
        return Schema.decodeSync(Score)(encoded) === score
      }),
    )
  })
})

describe("RuleId", () => {
  test("accepts namespace/name shapes", () => {
    expect(Schema.is(RuleId)("effect/no-let")).toBe(true)
    expect(Schema.is(RuleId)("ts/2322")).toBe(true)
    expect(Schema.is(RuleId)("evals/nonempty-scorers")).toBe(true)
    expect(Schema.is(RuleId)("boundaries/illegal-import")).toBe(true)
  })

  test("rejects malformed ids", () => {
    expect(Schema.is(RuleId)("no-namespace")).toBe(false)
    expect(Schema.is(RuleId)("UPPER/no-let")).toBe(false)
    expect(Schema.is(RuleId)("effect/")).toBe(false)
    expect(Schema.is(RuleId)("/no-let")).toBe(false)
  })
})

describe("AttemptNumber", () => {
  test("is a positive integer", () => {
    expect(Number(AttemptNumber.make(1))).toBe(1)
    expect(Schema.is(AttemptNumber)(0)).toBe(false)
    expect(Schema.is(AttemptNumber)(1.5)).toBe(false)
  })
})
