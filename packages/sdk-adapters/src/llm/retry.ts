import { AiError } from "@effect/ai"
import { Duration, Effect } from "effect"

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
 */

const MAX_RETRIES = 3
const BASE_MS = 1_000
const MAX_BACKOFF_MS = 8_000

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

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into ms, if present. */
const retryAfterMs = (e: AiError.AiError): number | undefined => {
  if (e._tag !== "HttpResponseError") return undefined
  const raw = e.response.headers["retry-after"] ?? e.response.headers["Retry-After"]
  if (raw === undefined || raw.length === 0) return undefined
  const secs = Number(raw)
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000))
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined
}

/** Exponential 1s → 2s → 4s, capped, with ±25% jitter to avoid a thundering herd. */
const backoffMs = (attempt: number): number => {
  const base = Math.min(MAX_BACKOFF_MS, BASE_MS * 2 ** attempt)
  return Math.round(base * (0.75 + Math.random() * 0.5))
}

/**
 * Wrap an LLM call so a transient provider failure is retried with backoff.
 * Honors `Retry-After` when the provider sends one, else exponential backoff,
 * up to {@link MAX_RETRIES} retries. Each retry annotates the active span and
 * logs a warning, so the wait shows up in telemetry and the `llm.generate`
 * span's logs. Place this INSIDE the span (so the annotations land on it) but
 * OUTSIDE the success/error observers (so they only see the final outcome).
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
        (e: E) => n < MAX_RETRIES && AiError.isAiError(e) && isTransientAiError(e),
        (e: E) => {
          const err = e as AiError.AiError
          const delay = retryAfterMs(err) ?? backoffMs(n)
          return Effect.annotateCurrentSpan({
            "llm.retry": true,
            "llm.retry.attempt": n + 1,
            "llm.retry.reason": reasonLabel(err),
            "llm.retry.delay_ms": delay,
          }).pipe(
            Effect.zipRight(
              Effect.logWarning(
                `LLM ${reasonLabel(err)} — retrying in ${delay}ms (attempt ${n + 1}/${MAX_RETRIES})`,
              ),
            ),
            Effect.zipRight(Effect.sleep(Duration.millis(delay))),
            Effect.zipRight(Effect.suspend(() => attempt(n + 1))),
          )
        },
      ),
    )
  return attempt(0)
}
