import { expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { ModelId, ModelSelection, ProviderId } from "../domain/model-selection.entity.js"
import { MemoryObservation } from "./memory-maintenance.entity.js"
import { scaledTokens } from "./memory-maintenance.entity.functions.js"

const model = new ModelSelection({ provider: ProviderId.make("fixture"), modelId: ModelId.make("actual") })
const observation: MemoryObservation = { model, inputTokens: 1500, estimatedTokens: 1000, reservedTokens: 200 }

test("scaling counts reserves once, never shrinks and estimates the new tail", () => {
  expect(scaledTokens(1000, Option.some(observation))).toBe(1300)
  expect(scaledTokens(1500, Option.some(observation))).toBe(1950)
  expect(scaledTokens(10, Option.some({ ...observation, inputTokens: 1 }))).toBe(10)
  expect(scaledTokens(1, Option.some(observation))).toBe(2)
  expect(scaledTokens(0, Option.some(observation))).toBe(0)
  expect(scaledTokens(42, Option.none())).toBe(42)
  expect(scaledTokens(42, Option.some({ ...observation, estimatedTokens: 0 }))).toBe(42)
  expect(scaledTokens(Number.MAX_SAFE_INTEGER, Option.some(observation))).toBe(Number.MAX_SAFE_INTEGER)
})

test("invalid evidence cannot calibrate and the schema rejects unsafe or absent model/counts", () => {
  ;[NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1].forEach(inputTokens => {
    expect(Schema.decodeUnknownOption(MemoryObservation)({ ...observation, inputTokens })._tag).toBe("None")
    expect(scaledTokens(42, Option.some({ ...observation, inputTokens }))).toBe(42)
  })
  expect(Schema.decodeUnknownOption(MemoryObservation)({ ...observation, model: null })._tag).toBe("None")
  expect(Schema.decodeUnknownOption(MemoryObservation)({ ...observation, reservedTokens: -1 })._tag).toBe("None")
})
