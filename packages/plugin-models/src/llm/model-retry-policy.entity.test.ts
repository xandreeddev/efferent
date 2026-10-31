import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { ModelRetryPolicy, modelRetryDefaults } from "./model-retry-policy.entity.js"

describe("model request policy", () => {
  test("the public defaults include four total attempts and finite HTTP bounds", () => {
    expect(modelRetryDefaults).toEqual({ maxAttempts: 4, requestTimeoutMs: 300000, bodyIdleTimeoutMs: 300000, totalTimeoutMs: 600000, retryAfterMaxMs: 60000, backoff: { initialMs: 1000, maxMs: 4000, jitter: 0.2 } })
    expect(Schema.decodeUnknownOption(ModelRetryPolicy)(modelRetryDefaults)).toEqual(Option.some(modelRetryDefaults))
  })
  test("attempts and timeouts are finite positive integers; delay bounds are nonnegative", () => {
    ;["maxAttempts", "requestTimeoutMs", "bodyIdleTimeoutMs", "totalTimeoutMs"].forEach((field) => [0, -1, 0.5, Infinity, NaN].forEach((invalid) => expect(Schema.decodeUnknownOption(ModelRetryPolicy)({ ...modelRetryDefaults, [field]: invalid })).toEqual(Option.none())))
    ;[-1, 0.5, Infinity, NaN].forEach((retryAfterMaxMs) => expect(Schema.decodeUnknownOption(ModelRetryPolicy)({ ...modelRetryDefaults, retryAfterMaxMs })).toEqual(Option.none()))
    ;[{ initialMs: -1, maxMs: 4, jitter: 0 }, { initialMs: 5, maxMs: 4, jitter: 0 }, { initialMs: 0, maxMs: 1, jitter: -0.1 }, { initialMs: 0, maxMs: 1, jitter: 1.1 }].forEach((backoff) => expect(Schema.decodeUnknownOption(ModelRetryPolicy)({ ...modelRetryDefaults, backoff })).toEqual(Option.none()))
    expect(Schema.decodeUnknownOption(ModelRetryPolicy)({ ...modelRetryDefaults, maxAttempts: 1, retryAfterMaxMs: 0, backoff: { initialMs: 0, maxMs: 0, jitter: 0 } })).toEqual(Option.some({ ...modelRetryDefaults, maxAttempts: 1, retryAfterMaxMs: 0, backoff: { initialMs: 0, maxMs: 0, jitter: 0 } }))
  })
})
