import { AiError } from "effect/ai"
import { HttpClientError } from "effect/http"
import { Clock, Deferred, Duration, Effect, Predicate, Ref, Schedule, Stream } from "effect"
import { CurrentEmptyResponseTolerance } from "@xandreed/core"

/**
 * Transient-failure resilience for every routed LLM call — the survival
 * learnings from the previous line, v1-scoped:
 *
 * - Retry ONLY transients (429 / 5xx / transport / timeout / empty body) —
 *   never a 4xx client error or a decode failure, which are permanent.
 * - Every attempt is bounded by a {@link LLM_REQUEST_TIMEOUT_MS} fiber-level
 *   timeout (official provider clients ship none), classified transient, and
 *   a routed call's attempts, backoff and fallback rung by its
 *   {@link CallBudget}. Tool time counts against neither: once a tool
 *   handler has started the call is final, never retried, never cut.
 * - An HTTP 200 with no text/tool-call/reasoning content is rejected as a
 *   transient failure (the "empty response that fake-completes a turn
 *   mid-thought" class) and rides the same retries.
 * - An exhausted balance or quota (`QuotaExhaustedError`) is PERMANENT:
 *   it fails fast and never reaches the fallback model.
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
/** One attempt, until its response is complete. */
export const LLM_REQUEST_TIMEOUT_MS = 300_000
/** One routed call: its attempts, their backoff and the fallback rung. */
export const LLM_CALL_BUDGET_MS = 600_000
export const MAX_HONORED_RETRY_AFTER_MS = 60_000

/**
 * The bound of one routed call, shared by its attempts and its fallback rung
 * (a retry never resets it). No attempt starts at or after `deadline`, and an
 * attempt is cut at it. `handedOff` is done once the call has handed its
 * first tool call to the toolkit: from then on the call is final, with no
 * retry, no fallback and no bound, since a second attempt would run the
 * tools again; a handler that never ends is bounded by the tool itself.
 */
export interface CallBudget {
  /** Clock millis. */
  readonly deadline: number
  /** The budget the deadline was set with, for the message of a call it cuts. */
  readonly budgetMs: number
  readonly handedOff: Deferred.Deferred<void>
}

/** A call's budget, its deadline `budgetMs` from now on the `Clock`. */
export const makeCallBudget = (budgetMs: number = LLM_CALL_BUDGET_MS): Effect.Effect<CallBudget> =>
  Effect.all([Clock.currentTimeMillis, Deferred.make<void>()], { concurrency: 1 }).pipe(
    Effect.map(([now, handedOff]) => ({ deadline: now + budgetMs, budgetMs, handedOff })),
  )

export type ErrorClass = "transient" | "permanent"

/** `Retry-After` millis — the integer-seconds form, or the HTTP-date form measured from `now`. */
const retryAfterMillis = (
  headers: Readonly<Record<string, unknown>> | undefined,
  now: number,
): number | undefined => {
  const raw = headers?.["retry-after"]
  if (!Predicate.isString(raw)) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return seconds * 1000
  const at = Date.parse(raw)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

/** A 429 whose wait exceeds the honored cap is a daily quota, not an outage. */
const rateLimited = (waitMs: number | undefined): ErrorClass =>
  waitMs !== undefined && waitMs > MAX_HONORED_RETRY_AFTER_MS ? "permanent" : "transient"

/** Whether `error` is worth a retry or a fallback; `now` (epoch millis) measures an HTTP-date `Retry-After`. */
export const classifyLlmError = (error: unknown, now: number): ErrorClass => {
  if (!AiError.isAiError(error)) {
    // A raw HTTP client's transport failure (the codex socket path).
    return HttpClientError.isHttpClientError(error) && error.reason._tag === "TransportError" ? "transient" : "permanent"
  }
  const reason = error.reason
  // An exhausted balance or quota, whatever status carried it (a gateway's
  // 402, a 429 naming `insufficient_quota`): no retry or fallback fixes it.
  if (reason._tag === "QuotaExhaustedError") return "permanent"
  const response = "http" in reason ? reason.http?.response : undefined
  if (response !== undefined) {
    if (response.status === 429) {
      // Beyond the honored cap this is a daily quota — retrying in seconds
      // hits the same wall; fail fast and let the caller change model.
      return rateLimited(retryAfterMillis(response.headers, now))
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

/** {@link classifyLlmError} at the `Clock`'s time: `true` for a transient failure. */
export const isTransientLlmError = (error: unknown): Effect.Effect<boolean> =>
  Effect.map(Clock.currentTimeMillis, (now) => classifyLlmError(error, now) === "transient")

/**
 * Whether a call that failed with `error` may try again, by a retry or on
 * the fallback rung: the failure is transient, no tool call was handed off,
 * and the budget's deadline has not come.
 */
export const canTryAgain = (budget: CallBudget) => (error: unknown): Effect.Effect<boolean> =>
  Effect.all([isTransientLlmError(error), Deferred.isDone(budget.handedOff), Clock.currentTimeMillis], { concurrency: 1 }).pipe(
    Effect.map(([transient, handedOff, now]) => transient && !handedOff && now < budget.deadline),
  )

/** 3 fast retries: exponential 1s → 2s → 4s, each jittered by up to ±20%. */
const fastRetries = Schedule.max([
  Schedule.exponential(Duration.seconds(1)).pipe(Schedule.jittered),
  Schedule.recurs(3),
])

const routerError = (method: string, description: string): AiError.AiError =>
  AiError.make({ module: "Router", method, reason: new AiError.UnknownError({ description }) })

const timeoutError = (label: string, method: string, timeoutMs: number): AiError.AiError =>
  routerError(method, `the ${label} request exceeded ${timeoutMs / 1000}s and was cut off`)

const budgetError = (label: string, budget: CallBudget, attempts: number): AiError.AiError =>
  routerError(
    "generateText",
    `the ${label} call reached its ${budget.budgetMs / 1000}s budget after ${attempts} ${attempts === 1 ? "attempt" : "attempts"} and was cut off`,
  )

const emptyError = (label: string, method: string): AiError.AiError =>
  routerError(
    method,
    `${label} returned an empty response (no text, tool call, or reasoning) — treated as a transient provider failure`,
  )

/** A part's `type`, "" for a value that has none: the router hands these
 *  guards its providers' parts untyped, and effect/ai's decoded parts
 *  (`Response.AnyPart`) and encoded ones share `type` and `delta`. */
const partType = (part: unknown): string =>
  Predicate.hasProperty(part, "type") && Predicate.isString(part.type) ? part.type : ""

const isContentPart = (part: unknown): boolean => {
  const type = partType(part)
  return type === "text" || type === "tool-call" || type === "reasoning"
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

/**
 * Fails the attempt it races with `cut` when `ms` pass before the call hands
 * a tool call off; once the call has, it never ends, so the call runs on
 * without a bound.
 */
const watchdog = (handedOff: Deferred.Deferred<void>, ms: number, cut: AiError.AiError): Effect.Effect<never, AiError.AiError> =>
  Deferred.await(handedOff).pipe(
    Effect.timeoutOrElse({ duration: Duration.millis(ms), orElse: () => Effect.fail(cut) }),
    Effect.andThen(Effect.never),
  )

/**
 * Transient-only retries around one routed LLM call, within its budget (a
 * fresh one when none is given, whose hand-off then nothing marks):
 *
 * - An attempt is bounded by {@link LLM_REQUEST_TIMEOUT_MS} or what is left
 *   of the budget, whichever is less. The bound races the call instead of
 *   wrapping it, so it stops at the hand-off and tool time never counts.
 * - A failure is retried only while {@link canTryAgain} holds, and no attempt
 *   starts at or after the deadline. A call the budget cuts fails naming the
 *   budget and its attempts.
 */
export const retryableLlm =
  (label: string, budget?: CallBudget) =>
  <A, E, R>(call: Effect.Effect<A, E, R>): Effect.Effect<A, E | AiError.AiError, R> =>
    Effect.gen(function* () {
      const bound = budget ?? (yield* makeCallBudget())
      const attempts = yield* Ref.make(0)
      const attempt = Effect.all([Clock.currentTimeMillis, Ref.get(attempts)], { concurrency: 1 }).pipe(
        Effect.flatMap(([now, made]) => {
          const left = bound.deadline - now
          if (left <= 0) return Effect.fail(budgetError(label, bound, made))
          const cut = left < LLM_REQUEST_TIMEOUT_MS
            ? budgetError(label, bound, made + 1)
            : timeoutError(label, "generateText", LLM_REQUEST_TIMEOUT_MS)
          return Ref.set(attempts, made + 1).pipe(
            Effect.andThen(Effect.raceFirst(call, watchdog(bound.handedOff, Math.min(LLM_REQUEST_TIMEOUT_MS, left), cut))),
          )
        }),
      )
      return yield* attempt.pipe(
        Effect.retry({ schedule: fastRetries, while: canTryAgain(bound) }),
        Effect.tapError((error) =>
          Effect.all([isTransientLlmError(error), Deferred.isDone(bound.handedOff)], { concurrency: 1 }).pipe(
            Effect.flatMap(([transient, handedOff]) =>
              transient
                ? Effect.logWarning(`${handedOff ? "transient failure after a tool started was final" : "transient failure exhausted retries"}: ${String(error)}`).pipe(
                  Effect.annotateLogs("llm.model", label),
                )
                : Effect.void,
            ),
          ),
        ),
      )
    })

/** Content-part identity, on the stream vocabulary: a non-empty
 *  text/reasoning delta or a tool call. The retry gate arms on it, the
 *  empty guard counts it — S1 guarantees empty deltas never reach here. */
const isStreamContentPart = (part: unknown): boolean => {
  const type = partType(part)
  if (type === "tool-call") return true
  return (
    (type === "text-delta" || type === "reasoning-delta") &&
    Predicate.hasProperty(part, "delta") &&
    Predicate.isString(part.delta) &&
    part.delta.length > 0
  )
}

const isFinishPart = (part: unknown): boolean => partType(part) === "finish"

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
            isStreamContentPart(part)
              ? Ref.set(contentSeen, true).pipe(Effect.as(part))
              : isFinishPart(part)
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
                  Effect.flatMap((seen) => seen ? Effect.succeed(false) : isTransientLlmError(input)),
                ),
              ),
            ),
          ),
          Stream.tapError((error) =>
            Effect.flatMap(isTransientLlmError(error), (transient) =>
              transient
                ? Effect.logWarning(`transient stream failure was final: ${String(error)}`).pipe(Effect.annotateLogs("llm.model", label))
                : Effect.void,
            ),
          ),
        )
      }),
    )
