import { expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { gate } from "./suite.entity.functions.js"
import { Gate } from "./suite.entity.js"

test("a gate from its grader, metric and one bound: passRate, blocking and reviewed references by default", () => {
  expect(gate({ grader: "answer@1", metric: "holds", minimum: 0.8 })).toEqual({
    grader: "answer@1", metric: "holds", aggregate: "passRate", mode: "blocking",
    minimum: Option.some(0.8), maximum: Option.none(), requiresReviewedReference: true,
  })
})

test("each default is the author's to change, and the gate it makes is one the suite's schema accepts", () => {
  const made = gate({ grader: "cost@1", metric: "usd", maximum: 0.01, aggregate: "mean", mode: "diagnostic", requiresReviewedReference: false })
  expect(made).toEqual({
    grader: "cost@1", metric: "usd", aggregate: "mean", mode: "diagnostic",
    minimum: Option.none(), maximum: Option.some(0.01), requiresReviewedReference: false,
  })
  expect(Schema.is(Gate)(made)).toBe(true)
  expect(Schema.is(Gate)(gate({ grader: "a@1", metric: "m", minimum: 0, maximum: 1 }))).toBe(true)
})

test("type-level: a gate with neither bound does not compile", () => {
  // @ts-expect-error a gate needs a minimum or a maximum
  const loose = () => gate({ grader: "answer@1", metric: "holds" })
  expect(typeof loose).toBe("function")
})
