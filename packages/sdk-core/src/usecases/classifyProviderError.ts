import { AiError } from "@effect/ai"
import type { ProviderDefectClass } from "../entities/Outcome.js"

/**
 * Classify a provider failure into the {@link ProviderDefectClass} taxonomy —
 * the single decision behind "retry, fail over, or surface":
 *
 *   - `transient` — 429 / retryable 5xx / transport / fetch timeout: the
 *     request was fine, the provider couldn't serve it NOW. Retried in place
 *     (`retryableLlm`).
 *   - `quota`     — the account is out of budget for HOURS (a daily-quota 429
 *     whose Retry-After exceeds the honor ceiling, "insufficient balance",
 *     usage-limit bodies). Retrying in place is pointless; the router fails
 *     over to the configured fallback selection.
 *   - `config`    — the REQUEST is invalid for this model/provider (a 400
 *     invalid-param like kimi's `invalid thinking`, a 404 endpoint). Retrying
 *     is pointless; failover gives the run a working model while the human
 *     fixes the config.
 *   - `auth`      — 401/403/revoked credential. NEVER fails over silently —
 *     surfaces with the `:login` hint (the human owns credentials).
 *   - `model`     — the model emitted something undecodable (MalformedOutput).
 *     Classified for observability; the LOOP owns recovery here (corrective
 *     messages, MAX_MALFORMED), so the router does NOT fail over on it.
 *
 * The forensic classes this gives a typed home to: opencode `CreditsError:
 * Insufficient balance`, `GoUsageLimitError: Weekly usage limit reached`, the
 * multi-hour daily-quota Retry-After, kimi's `invalid thinking` 400, and the
 * `api.anthropic.com/v1/messages?beta=true` 404 — all previously identical
 * anonymous node deaths.
 */

/** Honor a provider's `Retry-After` only up to this; longer ⇒ `quota`. Kept in
 *  lockstep with the adapter's retry ceiling. */
export const QUOTA_RETRY_AFTER_MS = 60_000

const QUOTA_BODY = /insufficient\s+balance|credits?err|out of credits|usage limit|quota exceeded|billing/i

const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504])

const transientText = (d: string): boolean => {
  const t = d.toLowerCase()
  return (
    t.includes("timeout") ||
    t.includes("timed out") ||
    t.includes("aborted") ||
    t.includes("fetch failed") ||
    t.includes("network") ||
    t.includes("econnreset") ||
    t.includes("econnrefused") ||
    t.includes("etimedout") ||
    t.includes("socket hang up")
  )
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into ms. */
export const parseRetryAfterMs = (
  raw: string | undefined,
  nowMs: number,
): number | undefined => {
  if (raw === undefined || raw.length === 0) return undefined
  const secs = Number(raw)
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000))
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined
}

export const classifyProviderError = (
  e: unknown,
  nowMs: number = Date.now(),
): ProviderDefectClass | undefined => {
  if (!AiError.isAiError(e)) return undefined
  switch (e._tag) {
    case "HttpResponseError": {
      const status = e.response.status
      const body = `${(e as { body?: unknown }).body ?? ""} ${e.description ?? ""}`
      if (status === 401 || status === 403) return "auth"
      if (status === 402 || QUOTA_BODY.test(body)) return "quota"
      if (status === 429) {
        const retryAfter = parseRetryAfterMs(
          e.response.headers["retry-after"] ?? e.response.headers["Retry-After"],
          nowMs,
        )
        // A multi-hour wait is a quota wall, not a blip.
        return retryAfter !== undefined && retryAfter > QUOTA_RETRY_AFTER_MS
          ? "quota"
          : "transient"
      }
      if (status === 400 || status === 404 || status === 422) return "config"
      if (TRANSIENT_STATUS.has(status)) return "transient"
      return undefined
    }
    case "HttpRequestError":
      return "transient"
    case "MalformedOutput":
      return "model"
    case "UnknownError": {
      const d = `${e.description}`
      if (QUOTA_BODY.test(d)) return "quota"
      if (transientText(d)) return "transient"
      return undefined
    }
    default:
      return undefined
  }
}
