import { Option } from "effect"
import type { ModelFailureKind } from "@xandreed/core"
import { ModelRequestState } from "./model-retry-policy.entity.js"
import type { ModelRetryPolicy } from "./model-retry-policy.entity.js"

/** Non-negative decimal digits, as the provider SDKs read a delay (`1`, `1.5`, `.5`). */
const DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)$/

/** Parse a `retry-after` value: non-negative seconds (decimals as the provider SDKs read them) or an HTTP date, never arbitrary text. */
export const retryAfterMillis = (value: string, now: number): Option.Option<number> => {
  const text = value.trim()
  if (DECIMAL.test(text)) {
    const millis = Number(text) * 1000
    return Number.isFinite(millis) ? Option.some(millis) : Option.none()
  }
  const date = /^[A-Za-z]{3,9}[ ,]/.test(text) ? Date.parse(text) : NaN
  return Number.isFinite(date) ? Option.some(Math.max(0, date - now)) : Option.none()
}

/** Parse a `retry-after-ms` value: non-negative milliseconds. */
export const retryAfterMsMillis = (value: string): Option.Option<number> => {
  const text = value.trim()
  const millis = DECIMAL.test(text) ? Number(text) : NaN
  return Number.isFinite(millis) ? Option.some(millis) : Option.none()
}

const headerText = (headers: Readonly<Record<string, unknown>>, name: string): Option.Option<string> =>
  Option.filter(Option.fromNullishOr(Object.hasOwn(headers, name) ? headers[name] : undefined), (value): value is string => typeof value === "string")

/** A rejected response's server hint: `retry-after-ms` (milliseconds) first, then `retry-after`; none when neither parses. */
export const retryHintMillis = (headers: Readonly<Record<string, unknown>>, now: number): Option.Option<number> =>
  Option.orElse(Option.flatMap(headerText(headers, "retry-after-ms"), retryAfterMsMillis), () => Option.flatMap(headerText(headers, "retry-after"), (value) => retryAfterMillis(value, now)))

/** One physical-attempt ordinal drives both bounded local delay and the capped server hint (milliseconds). */
export const retryDelayMillis = (policy: ModelRetryPolicy, attempt: number, unit: number, hint: Option.Option<number>): number => {
  const base = Math.min(policy.backoff.maxMs, policy.backoff.initialMs * 2 ** Math.min(1023, Math.max(0, attempt - 1)))
  const jittered = Math.min(policy.backoff.maxMs, Math.max(0, Math.round(base * (1 - policy.backoff.jitter + 2 * policy.backoff.jitter * unit))))
  return Math.max(jittered, Math.min(policy.retryAfterMaxMs, Option.getOrElse(hint, () => 0)))
}

export const primaryAttemptLimit = (policy: ModelRetryPolicy, reserveFallback: boolean): number => reserveFallback && policy.maxAttempts >= 2 ? policy.maxAttempts - 1 : policy.maxAttempts

export const retryableModelFailure = (kind: ModelFailureKind): boolean => kind === "Transient" || kind === "Timeout" || kind === "RateLimit"

export const startAttemptState = (state: ModelRequestState, policy: ModelRetryPolicy, reserveFallback: boolean): Option.Option<ModelRequestState> => {
  const start = (): Option.Option<ModelRequestState> => state.attempts < (state.rung === "Primary" ? primaryAttemptLimit(policy, reserveFallback) : policy.maxAttempts)
    ? Option.some({ _tag: "Sending", rung: state.rung, attempts: state.attempts + 1 }) : Option.none()
  return ModelRequestState.match(state, {
    Ready: start,
    Sending: () => Option.none(),
    Rejected: (value) => retryableModelFailure(value.kind) && value.replayable ? start() : Option.none(),
    Committed: () => Option.none(),
    Final: () => Option.none(),
  })
}

export const enterFallbackState = (state: ModelRequestState, policy: ModelRetryPolicy, reserveFallback: boolean): Option.Option<ModelRequestState> => ModelRequestState.match(state, {
  Ready: () => Option.none(), Sending: () => Option.none(), Committed: () => Option.none(), Final: () => Option.none(),
  Rejected: (value) => reserveFallback && policy.maxAttempts >= 2 && value.rung === "Primary" && value.attempts >= primaryAttemptLimit(policy, true) && value.attempts < policy.maxAttempts && value.replayable && retryableModelFailure(value.kind)
    // The primary's backoff and server hint belong to its provider: the fallback sends at once.
    ? Option.some<ModelRequestState>({ _tag: "Ready", rung: "Fallback", attempts: value.attempts }) : Option.none(),
})
