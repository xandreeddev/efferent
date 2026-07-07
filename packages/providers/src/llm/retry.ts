import { AiError } from "@effect/ai"
import { Duration, Effect, Schedule } from "effect"

/**
 * Transient-failure resilience for every routed LLM call — the survival
 * learnings from the previous line, v1-scoped:
 *
 * - Retry ONLY transients (429 / 5xx / transport / timeout / empty body) —
 *   never a 4xx client error or a decode failure, which are permanent.
 * - Every request is bounded by a {@link LLM_REQUEST_TIMEOUT_MS} fiber-level
 *   timeout (official provider clients ship none), classified transient.
 * - An HTTP 200 with no text/tool-call/reasoning content is rejected as a
 *   transient failure (the "empty response that fake-completes a turn
 *   mid-thought" class) and rides the same retries.
 * - A `Retry-After` beyond {@link MAX_HONORED_RETRY_AFTER_MS} is a daily
 *   quota, not an outage — it fails fast rather than parking the run
 *   (the uncapped-Retry-After lesson).
 *
 * The previous line's multi-phase patient ladder (30-minute interactive
 * outage waits) is deliberately NOT ported yet — it needs a per-run
 * interaction policy the engine doesn't carry; add it when live use demands.
 */

export const LLM_REQUEST_TIMEOUT_MS = 120_000
export const MAX_HONORED_RETRY_AFTER_MS = 60_000

export type ErrorClass = "transient" | "permanent"

export const classifyLlmError = (error: unknown): ErrorClass => {
  const e = error as
    | {
        readonly _tag?: string
        readonly response?: { readonly status?: number }
        readonly description?: string
      }
    | null
  if (e === null || typeof e !== "object") return "permanent"
  if (e._tag === "HttpResponseError") {
    const status = e.response?.status ?? 0
    return status === 429 || status >= 500 ? "transient" : "permanent"
  }
  // Transport/timeout/empty-body failures arrive as UnknownError (fetch
  // rejection, our timeout, the empty-response rejection below).
  if (e._tag === "UnknownError" || e._tag === "HttpRequestError") return "transient"
  return "permanent"
}

/** 3 fast retries: exponential 1s → 2s → 4s with ±25% jitter. */
const fastRetries = Schedule.exponential(Duration.seconds(1)).pipe(
  Schedule.jittered,
  Schedule.intersect(Schedule.recurs(3)),
)

const timeoutError = (label: string): AiError.UnknownError =>
  new AiError.UnknownError({
    module: "Router",
    method: "generateText",
    description: `the ${label} request exceeded ${LLM_REQUEST_TIMEOUT_MS / 1000}s and was cut off`,
  })

const emptyError = (label: string): AiError.UnknownError =>
  new AiError.UnknownError({
    module: "Router",
    method: "generateText",
    description: `${label} returned an empty response (no text, tool call, or reasoning) — treated as a transient provider failure`,
  })

const isContentPart = (part: unknown): boolean => {
  const t = (part as { readonly type?: string } | null)?.type
  return t === "text" || t === "tool-call" || t === "reasoning"
}

/** Reject an HTTP-200-but-empty response so it retries instead of
 *  fake-completing the turn. */
export const rejectEmptyResponse =
  (label: string) =>
  <A extends { readonly content: ReadonlyArray<unknown> }, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | AiError.UnknownError, R> =>
    effect.pipe(
      Effect.filterOrFail(
        (res) => res.content.some(isContentPart),
        () => emptyError(label),
      ),
    )

/** Timeout + transient-only retries around one routed LLM connect. */
export const retryableLlm =
  (label: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | AiError.UnknownError, R> =>
    effect.pipe(
      Effect.timeoutFail({
        duration: Duration.millis(LLM_REQUEST_TIMEOUT_MS),
        onTimeout: () => timeoutError(label),
      }),
      Effect.retry({
        schedule: fastRetries,
        while: (error) => classifyLlmError(error) === "transient",
      }),
      Effect.tapError((error) =>
        classifyLlmError(error) === "transient"
          ? Effect.logWarning(`${label}: transient failure exhausted retries: ${String(error)}`)
          : Effect.void,
      ),
    )
