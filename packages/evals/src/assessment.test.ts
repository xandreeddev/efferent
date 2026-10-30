import { expect, test } from "bun:test"
import { Effect, Option, Predicate, Schema } from "effect"
import { validateDataset } from "./assessment.entity.functions.js"
import { compareCalibrationMetric, summarizeCalibration } from "./domain/grader-calibration.entity.functions.js"
import { assessBothOrders } from "./evaluators/pairwise.js"
import type { Dataset } from "./assessment.usecase.js"
import { spanRecorder } from "./testing/fixture.testing.js"

const data: Dataset<string, boolean> = {
  id: "examples", version: "1", input: Schema.String, reference: Schema.Boolean,
  cases: [
    { id: "good", family: "good", split: "calibration", review: "known", input: "supported", reference: true, provenance: "controlled fixture" },
    { id: "bad", family: "bad", split: "validation", review: "known", input: "fabricated", reference: false, provenance: "controlled fixture" },
  ],
}

test("dataset rejects duplicate IDs and cross-split case families", async () => {
  expect(await Effect.runPromise(validateDataset(data).pipe(Effect.isSuccess))).toBe(true)
  expect(await Effect.runPromise(validateDataset({ ...data, cases: data.cases.map((c) => ({ ...c, family: "shared" })) }).pipe(Effect.isSuccess))).toBe(false)
  expect(await Effect.runPromise(validateDataset({ ...data, cases: [...data.cases, data.cases[0]!] }).pipe(Effect.isSuccess))).toBe(false)
})
test("a case that does not decode is named, and its schema error kept as the cause", async () => {
  const error = await Effect.runPromise(validateDataset({ ...data, input: Schema.String.check(Schema.isNonEmpty()), cases: data.cases.map((c) => c.id === "bad" ? { ...c, input: "" } : c) }).pipe(Effect.flip))
  expect(error.code).toBe("invalid")
  expect(error.message).toStartWith("Dataset case bad does not decode: ")
  expect(Predicate.isTagged(error.cause, "SchemaError")).toBe(true)
})
test("calibration distinguishes probabilities from scalar scores", () => {
  const result = compareCalibrationMetric({ kind: "probability", name: "grounded", value: 0.8 }, { kind: "boolean", name: "grounded", value: true })
  expect(result.status).toBe("measured")
  if (result.status === "measured") expect(Option.getOrThrow(result.brier)).toBeCloseTo(0.04)
  expect(compareCalibrationMetric({ kind: "score", name: "grounded", value: 0.8, min: 0, max: 1 }, { kind: "boolean", name: "grounded", value: true }).status).toBe("unavailable")
})
test("pairwise positional preference is flagged, never reported as a tie", async () => {
  const result = await Effect.runPromise(assessBothOrders("left", "right", () => Effect.succeed("A")))
  expect(result).toEqual({ forward: "A", reverse: "A", consistent: false })
})
test("a pairwise assessment is one eval.pairwise span over both of its judge calls", async () => {
  const { tracer, named, parentOf } = spanRecorder()
  await Effect.runPromise(assessBothOrders("left", "right", () => Effect.succeed("tie" as const).pipe(Effect.withSpan("judge"))).pipe(Effect.withTracer(tracer)))
  expect(named("eval.pairwise")).toHaveLength(1)
  expect(named("judge").map(parentOf)).toEqual(["eval.pairwise", "eval.pairwise"])
})
test("calibration coverage excludes missing predictions and preserves confusion counts", () => {
  const result = summarizeCalibration([
    { actual: Option.some({ kind: "probability", name: "grounded", value: 0.9 }), reference: { kind: "boolean", name: "grounded", value: false } },
    { actual: Option.none(), reference: { kind: "boolean", name: "grounded", value: true } },
  ])
  expect(result.measured).toBe(1)
  expect(result.unavailable).toBe(1)
  expect(result.confusion.falsePositive).toBe(1)
  expect(Option.getOrThrow(result.brier)).toBeCloseTo(0.81)
  expect(Option.isNone(result.recall)).toBe(true)
  expect(result.reliability[9]?.count).toBe(1)
})
test("calibration measures two probabilities exactly, outside the confusion counts and the reliability bins", () => {
  expect(compareCalibrationMetric({ kind: "probability", name: "grounded", value: 0.7 }, { kind: "probability", name: "grounded", value: 0.7 }))
    .toEqual({ status: "measured", agreement: true, brier: Option.none(), absoluteError: Option.none(), falsePass: false, falseFail: false })
  const result = summarizeCalibration([
    { actual: Option.some({ kind: "probability", name: "grounded", value: 0.7 }), reference: { kind: "probability", name: "grounded", value: 0.7 } },
    { actual: Option.some({ kind: "probability", name: "grounded", value: 0.7 }), reference: { kind: "probability", name: "grounded", value: 0.75 } },
    { actual: Option.some({ kind: "probability", name: "grounded", value: 0.9 }), reference: { kind: "boolean", name: "grounded", value: true } },
  ])
  expect([result.measured, result.unavailable, Option.getOrThrow(result.agreement)]).toEqual([3, 0, 2 / 3])
  expect(result.confusion).toEqual({ truePositive: 1, trueNegative: 0, falsePositive: 0, falseNegative: 0 })
  expect(result.reliability.map(({ count }) => count)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
})
