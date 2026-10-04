import { AiError } from "effect/ai"
import { Duration, Effect, Ref, Schedule, Stream } from "effect"
import { CurrentEmptyResponseTolerance } from "@xandreed/core"

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
 * - A 429 whose `Retry-After` exceeds {@link MAX_HONORED_RETRY_AFTER_MS} is
 *   a daily quota, not an outage — {@link classifyLlmError} calls it
 *   PERMANENT so it fails fast instead of burning retries into the same
 *   wall (the uncapped-Retry-After lesson: never park a run on a quota).
 *   The fast-retry schedule itself never sleeps on the header.
 *
 * The previous line's multi-phase patient ladder (30-minute interactive
 * outage waits) is deliberately NOT ported yet — it needs a per-run
 * interaction policy the engine doesn't carry; add it when live use demands.
 */

// 300s, not 120: the compat path is NON-streaming and the gateway's models
// think by DEFAULT (live-probed: 400+ reasoning tokens unprompted), so the
// whole thinking time counts against this timeout before a single body byte
// arrives — the old line streamed, where first-byte came fast. The timeout
// exists to catch hung sockets; at 120s it would classify a healthy slow
// thinking turn as transient and retry it into the same wall.
export const LLM_REQUEST_TIMEOUT_MS = 300_000
export const MAX_HONORED_RETRY_AFTER_MS = 60_000

export type ErrorClass = "transient" | "permanent"

/** `Retry-After` millis — the integer-seconds form or the HTTP-date form. */
const retryAfterMillis = (
  headers: Record<string, string> | undefined,
): number | undefined => {
  const raw = headers?.["retry-after"]
  if (raw === undefined) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return seconds * 1000
  const at = Date.parse(raw)
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now())
}

/** A 429 whose wait exceeds the honored cap is a daily quota, not an outage. */
const rateLimited = (waitMs: number | undefined): ErrorClass =>
  waitMs !== undefined && waitMs > MAX_HONORED_RETRY_AFTER_MS ? "permanent" : "transient"

export const classifyLlmError = (error: unknown): ErrorClass => {
  if (!AiError.isAiError(error)) {
    // A raw HTTP client's transport failure (the codex socket path).
    const e = error as { readonly _tag?: string; readonly reason?: { readonly _tag?: string } } | null
    return e?._tag === "HttpClientError" && e.reason?._tag === "TransportError" ? "transient" : "permanent"
  }
  const reason = error.reason
  // Gateway configuration rejections can arrive behind a 5xx wrapper.
  // Their semantic classification must win over the transport status.
  if (reason._tag === "InvalidRequestError") return "permanent"
  const response = "http" in reason ? reason.http?.response : undefined
  if (response !== undefined) {
    if (response.status === 429) {
      // Beyond the honored cap this is a daily quota — retrying in seconds
      // hits the same wall; fail fast and let the caller change model.
      return rateLimited(retryAfterMillis(response.headers as Record<string, string>))
    }
    return response.status >= 500 ? "transient" : "permanent"
  }
  // Transport/timeout/empty-body failures arrive as UnknownError (fetch
  // rejection, our timeout, the empty-response rejection below); Effect's
  // providers report transport as NetworkError and 429/5xx by reason.
  if (reason._tag === "RateLimitError")
    return rateLimited(reason.retryAfter === undefined ? undefined : Duration.toMillis(reason.retryAfter))
  return reason._tag === "InternalProviderError" || reason._tag === "NetworkError" || reason._tag === "UnknownError"
    ? "transient"
    : "permanent"
}

/** 3 fast retries: exponential 1s → 2s → 4s with ±25% jitter. */
const fastRetries = Schedule.max([
  Schedule.exponential(Duration.seconds(1)).pipe(Schedule.jittered),
  Schedule.recurs(3),
])

const routerError = (method: string, description: string): AiError.AiError =>
  AiError.make({ module: "Router", method, reason: new AiError.UnknownError({ description }) })

const timeoutError = (label: string, method: string, timeoutMs: number): AiError.AiError =>
  routerError(method, `the ${label} request exceeded ${timeoutMs / 1000}s and was cut off`)

const emptyError = (label: string, method: string): AiError.AiError =>
  routerError(
    method,
    `${label} returned an empty response (no text, tool call, or reasoning) — treated as a transient provider failure`,
  )

const isContentPart = (part: unknown): boolean => {
  const t = (part as { readonly type?: string } | null)?.type
  return t === "text" || t === "tool-call" || t === "reasoning"
}

/** Reject an HTTP-200-but-empty response so it retries instead of
 *  fake-completing the turn — UNLESS the loop has declared tolerance
 *  ({@link CurrentEmptyResponseTolerance}): once a run has executed tool
 *  calls, a following empty response is the model finishing, and rejecting
 *  it would park the turn in the patient outage ladder. */
export const rejectEmptyResponse =
  (label: string) =>
  <A extends { readonly content: ReadonlyArray<unknown> }, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | AiError.AiError, R> =>
    Effect.service(CurrentEmptyResponseTolerance).pipe(
      Effect.flatMap((tolerant) =>
        tolerant
          ? effect
          : effect.pipe(
            Effect.filterOrFail(
              (res) => res.content.some(isContentPart),
              () => emptyError(label, "generateText"),
            ),
          ),
      ),
    )

/** Timeout + transient-only retries around one routed LLM connect. */
export const retryableLlm =
  (label: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | AiError.AiError, R> =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(LLM_REQUEST_TIMEOUT_MS),
        orElse: () => Effect.fail(timeoutError(label, "generateText", LLM_REQUEST_TIMEOUT_MS)),
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

/** Content-part identity, on the ENCODED stream vocabulary: a non-empty
 *  text/reasoning delta or a tool call. The retry gate arms on it, the
 *  empty guard counts it — S1 guarantees empty deltas never reach here. */
const isContentPartEncoded = (part: unknown): boolean => {
  const p = part as { readonly type?: string; readonly delta?: string } | null
  if (p === null || typeof p !== "object") return false
  if (p.type === "tool-call") return true
  return (
    (p.type === "text-delta" || p.type === "reasoning-delta") &&
    typeof p.delta === "string" &&
    p.delta.length > 0
  )
}

const isFinishPartEncoded = (part: unknown): boolean =>
  (part as { readonly type?: string } | null)?.type === "finish"

/**
 * The STREAM twin of {@link retryableLlm}, with semantics a settled call
 * doesn't need:
 *
 * - Retry covers connection + PRE-first-content failures only. Once a
 *   content part has flowed to the consumer, a replayed stream would emit
 *   duplicates — so after content, failures are final (a `Ref`-armed gate on
 *   the retry schedule).
 * - The empty guard WITHHOLDS the finish part: a finish with zero content
 *   parts fails as the transient empty-response error instead of
 *   fake-completing the turn — and, being pre-content by definition, it
 *   rides the same retries.
 * - The timeout is per-PART idle time (bounds time-to-first-part AND a
 *   mid-stream hang), not whole-request — a long healthy stream never trips
 *   it while tokens flow.
 */
export const retryableLlmStream =
  (label: string, timeoutMs: number = LLM_REQUEST_TIMEOUT_MS) =>
  <A, E, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<A, E | AiError.AiError, R> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const contentSeen = yield* Ref.make(false)
        return stream.pipe(
          Stream.mapEffect((part) =>
            isContentPartEncoded(part)
              ? Ref.set(contentSeen, true).pipe(Effect.as(part))
              : isFinishPartEncoded(part)
                ? Ref.get(contentSeen).pipe(
                    Effect.flatMap((seen) =>
                      seen ? Effect.succeed(part) : Effect.fail(emptyError(label, "streamText")),
                    ),
                  )
                : Effect.succeed(part),
          ),
          Stream.timeoutOrElse({
            duration: Duration.millis(timeoutMs),
            orElse: () => Stream.fail(timeoutError(label, "streamText", timeoutMs)),
          }),
          Stream.retry(
            fastRetries.pipe(
              Schedule.while(({ input }: { readonly input: E | AiError.AiError }) =>
                Ref.get(contentSeen).pipe(
                  Effect.map((seen) => !seen && classifyLlmError(input) === "transient"),
                ),
              ),
            ),
          ),
          Stream.tapError((error) =>
            classifyLlmError(error) === "transient"
              ? Effect.logWarning(`${label}: transient stream failure was final: ${String(error)}`)
              : Effect.void,
          ),
        )
      }),
    )
