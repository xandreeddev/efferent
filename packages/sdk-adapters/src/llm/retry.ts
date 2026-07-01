import { AiError } from "@effect/ai"
import { type AgentLlmRetryEvent, RunContextRef } from "@xandreed/sdk-core"
import { Duration, Effect, FiberRef } from "effect"

/**
 * Retry-with-backoff for LLM calls. The default provider (Kimi via the opencode
 * gateway) returns 429 "engine overloaded" under load; with no retry that was an
 * instant turn death, and a fleet would thrash — re-spawn, fail, re-spawn —
 * draining the token pool. This wraps a single LLM call so a *transient* failure
 * (rate-limit / provider overload / transport / timeout) is retried instead of
 * aborting the turn.
 *
 * Apply it around the CONNECT, never a live stream — wrapping `generateText`
 * (which collects the whole response into one Effect) or a provider's `postChat`
 * is safe; retrying a partially-emitted stream would duplicate tokens.
 *
 * Two properties the early version lacked, both fixed here:
 *   1. **The backoff is visible.** Each retry calls `RunContext.onLlmRetry` (a
 *      FiberRef sink the driver wires to the event stream), so the UI shows
 *      `retrying in 8s (1/3)` instead of a silent hang.
 *   2. **`Retry-After` is clamped.** The opencode gateway answers a 429 on daily-
 *      quota exhaustion with `Retry-After` = seconds-until-the-midnight-UTC reset
 *      — HOURS. The old code honored it verbatim and slept ~13h. We honor a wait
 *      only up to {@link MAX_HONORED_RETRY_AFTER_MS}; a longer one means quota/
 *      outage, so we DON'T retry — the error surfaces immediately and the human
 *      can switch models (`:model`) instead of staring at a frozen turn.
 */

const MAX_RETRIES = 3
const BASE_MS = 1_000
const MAX_BACKOFF_MS = 8_000
/** Honor a provider's `Retry-After` only up to a minute. Longer ⇒ not a
 *  transient blip but a rate/quota wall — fail fast rather than park the turn. */
export const MAX_HONORED_RETRY_AFTER_MS = 60_000
/**
 * Wall-clock ceiling on a single LLM request (connect + the full non-streamed
 * response). Was 5 min — far too long: a silently stalled gateway connection
 * (socket open, no bytes, no error) parked a *backgrounded* sub-agent for
 * minutes before this abort fired, with nothing on screen — the node sat
 * `running` with zero turns while its parent's `wait_for_agents` looped blind. 2
 * min bounds a real hang while leaving ample room for a slow-but-valid
 * completion; the abort is classified transient and RETRIED, so a genuine blip
 * recovers. The harder backstop is the sub-agent stall watchdog
 * (`SUBAGENT_STALL_DEADLINE_MS` in `buildScopeRuntime`), which interrupts a run
 * that makes no progress at all — covering a freeze this per-request timeout
 * can't (e.g. a deadlock that never even reaches the fetch).
 */
export const LLM_REQUEST_TIMEOUT_MS = 120_000

/** 429 (rate limit) + the retryable 5xx (overload / gateway / unavailable). */
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504])

/**
 * The custom adapters (`openCode`/`ollama`/`openAiCodex`) wrap a fetch
 * network/timeout failure as `AiError.UnknownError` with the cause stringified
 * into `description`. Sniff that for the transient transport signatures so an
 * aborted/timed-out/connection-reset fetch retries too.
 */
const transientUnknown = (description: string): boolean => {
  const d = description.toLowerCase()
  return (
    d.includes("timeout") ||
    d.includes("timed out") ||
    d.includes("aborted") ||
    d.includes("fetch failed") ||
    d.includes("network") ||
    d.includes("econnreset") ||
    d.includes("econnrefused") ||
    d.includes("etimedout") ||
    d.includes("socket hang up")
  )
}

/**
 * Worth retrying? Provider overload / rate-limit (429, retryable 5xx), transport
 * failures, and fetch timeouts — the request itself is fine, the provider just
 * couldn't serve it now. NEVER a 4xx client error (bad request / bad or expired
 * key) or a decode bug (`MalformedInput`/`MalformedOutput`) — those are permanent
 * and retrying only wastes tokens and hides the real fault.
 */
export const isTransientAiError = (e: AiError.AiError): boolean => {
  switch (e._tag) {
    case "HttpResponseError":
      return TRANSIENT_STATUS.has(e.response.status)
    case "HttpRequestError":
      return true
    case "UnknownError":
      return transientUnknown(`${e.description}`)
    default:
      return false
  }
}

const reasonLabel = (e: AiError.AiError): string =>
  e._tag === "HttpResponseError" ? `HTTP ${e.response.status}` : e._tag

/**
 * Parse a `Retry-After` header value (delta-seconds or an HTTP-date) into ms.
 * Pure — `nowMs` is passed so the HTTP-date branch is testable. Exported for the
 * regression test: the opencode daily-quota value (`"48489"` ⇒ 48 489 000 ms)
 * is exactly what must NOT be slept on.
 */
export const parseRetryAfter = (raw: string | undefined, nowMs: number): number | undefined => {
  if (raw === undefined || raw.length === 0) return undefined
  const secs = Number(raw)
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000))
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined
}

/** Exponential 1s → 2s → 4s, capped, with ±25% jitter to avoid a thundering herd. */
const backoffMs = (attempt: number): number => {
  const base = Math.min(MAX_BACKOFF_MS, BASE_MS * 2 ** attempt)
  return Math.round(base * (0.75 + Math.random() * 0.5))
}

/**
 * Given a parsed `Retry-After` (ms, or undefined) and the 0-based attempt,
 * decide whether to wait and for how long. A server wait over the ceiling is
 * REFUSED (`wait: false`) — that's the quota/outage case we fail fast on; an
 * absent header falls back to exponential backoff; everything is capped at the
 * ceiling. Pure; this is what the clamp test pins.
 */
export const planDelay = (
  retryAfterMs: number | undefined,
  attempt: number,
): { readonly wait: boolean; readonly delayMs: number } =>
  retryAfterMs !== undefined && retryAfterMs > MAX_HONORED_RETRY_AFTER_MS
    ? { wait: false, delayMs: 0 }
    : { wait: true, delayMs: Math.min(retryAfterMs ?? backoffMs(attempt), MAX_HONORED_RETRY_AFTER_MS) }

const retryAfterMs = (e: AiError.AiError): number | undefined => {
  if (e._tag !== "HttpResponseError") return undefined
  const raw = e.response.headers["retry-after"] ?? e.response.headers["Retry-After"]
  return parseRetryAfter(raw, Date.now())
}

interface Decision {
  readonly wait: boolean
  readonly delayMs: number
  readonly reason: string
}

/** The full retry decision for a failure on attempt `n` (0-based): transient?
 *  under the attempt cap? a sleepable wait? Combines the transient classifier
 *  with {@link planDelay}'s clamp. */
const decide = <E>(e: E, n: number): Decision => {
  if (n >= MAX_RETRIES || !AiError.isAiError(e) || !isTransientAiError(e))
    return { wait: false, delayMs: 0, reason: "" }
  const plan = planDelay(retryAfterMs(e), n)
  return { wait: plan.wait, delayMs: plan.delayMs, reason: reasonLabel(e) }
}

/** Push a retry notice to the driver's sink (FiberRef), if one is wired. */
const emitRetryNotice = (event: AgentLlmRetryEvent): Effect.Effect<void> =>
  FiberRef.get(RunContextRef).pipe(
    Effect.flatMap((rc) => (rc.onLlmRetry !== undefined ? rc.onLlmRetry(event) : Effect.void)),
  )

/**
 * Bound ONE LLM request at {@link LLM_REQUEST_TIMEOUT_MS} at the fiber level.
 * The custom adapters (`openCode`/`openAiCodex`/`openAiCompat`) already abort
 * their fetch with an `AbortSignal`; the official `@effect/ai-*` providers
 * (Google / OpenAI / Anthropic) had NO timeout at all, so a silently hung
 * socket parked the calling fiber forever — the root turn has no watchdog, so
 * this was the "root hangs indefinitely on a dead connection" primitive. The
 * timeout failure is an `UnknownError` whose description matches the transient
 * sniffer, so wrapping BEFORE {@link retryableLlm} makes each attempt bounded
 * AND retried — a genuine blip recovers, a dead provider surfaces in ~6 min
 * worst-case instead of never.
 *
 * E is preserved rather than widened: the failure is a real `AiError` at
 * runtime, but `ExtractError<Options>` is a generic the router's service
 * signature can't widen — same cast class as its `resolveKey` mapError.
 */
export const withLlmTimeout = <A, E, R>(
  eff: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  eff.pipe(
    Effect.timeoutFail({
      duration: Duration.millis(LLM_REQUEST_TIMEOUT_MS),
      onTimeout: () =>
        new AiError.UnknownError({
          module: "llm",
          method: "request",
          description: `request timed out after ${Math.round(LLM_REQUEST_TIMEOUT_MS / 1000)}s`,
        }) as never,
    }),
  )

/**
 * Wrap an LLM call so a transient provider failure is retried with backoff.
 * Honors `Retry-After` (clamped — see {@link MAX_HONORED_RETRY_AFTER_MS}), else
 * exponential backoff, up to {@link MAX_RETRIES} retries. Each retry emits a
 * visible notice, annotates the active span, and logs a warning. Place this
 * INSIDE the span (so annotations land on it) but OUTSIDE the success/error
 * observers (so they only see the final outcome).
 */
export const retryableLlm = <A, E, R>(
  eff: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  // E is wider than AiError (a provider's generateText folds in toolkit-handler
  // errors), so retry stays polymorphic and only fires on a transient AiError;
  // every other failure propagates unchanged.
  const attempt = (n: number): Effect.Effect<A, E, R> =>
    eff.pipe(
      Effect.catchIf(
        (e: E) => decide(e, n).wait,
        (e: E) => {
          const { delayMs, reason } = decide(e, n)
          return emitRetryNotice({
            reason,
            attempt: n + 1,
            maxAttempts: MAX_RETRIES,
            delayMs,
          }).pipe(
            Effect.zipRight(
              Effect.annotateCurrentSpan({
                "llm.retry": true,
                "llm.retry.attempt": n + 1,
                "llm.retry.reason": reason,
                "llm.retry.delay_ms": delayMs,
              }),
            ),
            Effect.zipRight(
              Effect.logWarning(
                `LLM ${reason} — retrying in ${delayMs}ms (attempt ${n + 1}/${MAX_RETRIES})`,
              ),
            ),
            Effect.zipRight(Effect.sleep(Duration.millis(delayMs))),
            Effect.zipRight(Effect.suspend(() => attempt(n + 1))),
          )
        },
      ),
    )
  return attempt(0)
}
