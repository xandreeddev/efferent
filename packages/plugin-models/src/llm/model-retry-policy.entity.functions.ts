import { Option } from "effect"
import type { ModelFailureKind } from "@xandreed/core"
import { ModelRequestState } from "./model-retry-policy.entity.js"
import type { ModelRetryPolicy } from "./model-retry-policy.entity.js"

/** Parse a server hint without treating arbitrary numeric strings as dates. */
export const retryAfterMillis = (value: string, now: number): Option.Option<number> => {
  const text = value.trim()
  if (/^\d+$/.test(text)) {
    const millis = Number(text) * 1000
    return Number.isFinite(millis) ? Option.some(millis) : Option.none()
  }
  const date = /^[A-Za-z]{3,9}[ ,]/.test(text) ? Date.parse(text) : NaN
  return Number.isFinite(date) ? Option.some(Math.max(0, date - now)) : Option.none()
}

/** One physical-attempt ordinal drives both bounded local delay and the capped server hint. */
export const retryDelayMillis = (policy: ModelRetryPolicy, attempt: number, unit: number, retryAfter: Option.Option<string>, now: number): number => {
  const base = Math.min(policy.backoff.maxMs, policy.backoff.initialMs * 2 ** Math.min(1023, Math.max(0, attempt - 1)))
  const jittered = Math.min(policy.backoff.maxMs, Math.max(0, Math.round(base * (1 - policy.backoff.jitter + 2 * policy.backoff.jitter * unit))))
  const hint = Option.getOrElse(Option.flatMap(retryAfter, (value) => retryAfterMillis(value, now)), () => 0)
  return Math.max(jittered, Math.min(policy.retryAfterMaxMs, hint))
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
  })
}

export const enterFallbackState = (state: ModelRequestState, policy: ModelRetryPolicy, reserveFallback: boolean): Option.Option<ModelRequestState> => ModelRequestState.match(state, {
  Ready: () => Option.none(), Sending: () => Option.none(), Committed: () => Option.none(),
  Rejected: (value) => reserveFallback && policy.maxAttempts >= 2 && value.rung === "Primary" && value.attempts >= primaryAttemptLimit(policy, true) && value.attempts < policy.maxAttempts && value.replayable && retryableModelFailure(value.kind)
    ? Option.some<ModelRequestState>({ _tag: "Ready", rung: "Fallback", attempts: value.attempts, ...(value.retryAt === undefined ? {} : { readyAt: value.retryAt }) }) : Option.none(),
})
