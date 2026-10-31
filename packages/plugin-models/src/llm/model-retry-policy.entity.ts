import { Schema } from "effect"
import { ModelFailureKind } from "@xandreed/core"

const positive = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const nonnegative = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** One logical model request's bounded HTTP retries and pending-read timeouts. @public */
export const ModelRetryPolicy = Schema.Struct({
  maxAttempts: positive,
  requestTimeoutMs: positive,
  bodyIdleTimeoutMs: positive,
  totalTimeoutMs: positive,
  retryAfterMaxMs: nonnegative,
  backoff: Schema.Struct({ initialMs: nonnegative, maxMs: nonnegative, jitter: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })) }).check(Schema.makeFilter((value) => value.maxMs >= value.initialMs ? true : "maximum backoff must be at least its initial delay")),
})
export type ModelRetryPolicy = typeof ModelRetryPolicy.Type

/** Full defaults; an initial send counts toward maxAttempts. @public */
export const modelRetryDefaults: ModelRetryPolicy = {
  maxAttempts: 4, requestTimeoutMs: 300000, bodyIdleTimeoutMs: 300000,
  totalTimeoutMs: 600000, retryAfterMaxMs: 60000,
  backoff: { initialMs: 1000, maxMs: 4000, jitter: 0.2 },
}

export const ModelRequestRung = Schema.Literals(["Primary", "Fallback"])
export type ModelRequestRung = typeof ModelRequestRung.Type

/** Private attempt state, shared by one routed call and its distinct fallback. */
export const ModelRequestState = Schema.Union([
  Schema.TaggedStruct("Ready", { rung: ModelRequestRung, attempts: nonnegative, readyAt: Schema.optionalKey(nonnegative) }),
  Schema.TaggedStruct("Sending", { rung: ModelRequestRung, attempts: positive }),
  Schema.TaggedStruct("Rejected", { rung: ModelRequestRung, attempts: positive, kind: ModelFailureKind, replayable: Schema.Boolean, retryAt: Schema.optionalKey(nonnegative) }),
  Schema.TaggedStruct("Committed", { rung: ModelRequestRung, attempts: positive }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type ModelRequestState = typeof ModelRequestState.Type
