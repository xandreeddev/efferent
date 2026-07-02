import { AiError } from "@effect/ai"
import { classifyProviderError, type AgentLlmRetryEvent, RunContextRef } from "@xandreed/sdk-core"
import { Clock, Duration, Effect, FiberRef } from "effect"

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

/**
 * The PATIENT phase — how a session survives a real provider outage instead of
 * dying at the finish line. The July forensics: the opencode gateway went down
 * for ~2.5h; the root's synthesis turn (the fleet's 7 finished audits, waiting
 * to be delivered) burned the 3 fast retries in ~8 min and killed the run —
 * the deliverable was never shown. Claude Code survives the same outage by
 * simply *waiting it out visibly*. So after the fast retries, a transient
 * failure keeps retrying on a slow ladder (15s → 30s → 60s → 60s …), bounded
 * by a wall-clock budget chosen by the run's interaction policy:
 *
 *   - `interactive` — a human is watching and can Esc anytime; wait up to
 *     30 min (every wait is on-screen: "provider down 6m — retrying").
 *   - `headless`    — unattended; 10 min, inside the fleet deadline.
 *   - none          — bare calls (evals, tests, helper tiers outside a run):
 *     fast retries only, exactly the old behavior.
 *
 * Only `transient` failures ride the ladder — quota/config/auth/model still
 * fail fast to the router's failover / the human.
 */
export const PATIENT_BUDGET_INTERACTIVE_MS = 30 * 60_000
export const PATIENT_BUDGET_HEADLESS_MS = 10 * 60_000
const PATIENT_LADDER_MS = [15_000, 30_000, 60_000] as const

export const patientBudgetFor = (
  policy: "interactive" | "headless" | undefined,
): number =>
  policy === "interactive"
    ? PATIENT_BUDGET_INTERACTIVE_MS
    : policy === "headless"
      ? PATIENT_BUDGET_HEADLESS_MS
      : 0
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

/**
 * Worth retrying? Exactly the `transient` class of the shared taxonomy
 * (`classifyProviderError` in sdk-core): provider overload / rate-limit,
 * transport failures, fetch timeouts — the request itself is fine, the
 * provider just couldn't serve it now. `quota`/`config`/`auth`/`model`
 * failures are PERMANENT here and fail fast — the router decides whether a
 * failover applies (quota/config) or the human must act (auth).
 */
export const isTransientAiError = (e: AiError.AiError): boolean =>
  classifyProviderError(e) === "transient"

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
  readonly phase: "fast" | "patient"
}

const NO_RETRY: Decision = { wait: false, delayMs: 0, reason: "", phase: "fast" }

/**
 * The full retry decision for a failure on attempt `n` (0-based): transient?
 * fast phase (attempt cap + {@link planDelay}'s clamp) or patient phase
 * (slow ladder while the wall-clock budget lasts)? Pure — pinned by tests.
 */
export const planRetry = <E>(
  e: E,
  n: number,
  elapsedMs: number,
  budgetMs: number,
): Decision => {
  if (!AiError.isAiError(e) || !isTransientAiError(e)) return NO_RETRY
  if (n < MAX_RETRIES) {
    const plan = planDelay(retryAfterMs(e), n)
    // A refused fast-phase wait (a Retry-After over the ceiling) is a quota
    // wall, never worth the patient ladder either.
    return { wait: plan.wait, delayMs: plan.delayMs, reason: reasonLabel(e), phase: "fast" }
  }
  if (budgetMs <= 0 || elapsedMs >= budgetMs) return NO_RETRY
  const rung = PATIENT_LADDER_MS[Math.min(n - MAX_RETRIES, PATIENT_LADDER_MS.length - 1)] ?? 60_000
  const delay = Math.round(rung * (0.75 + Math.random() * 0.5))
  return { wait: true, delayMs: delay, reason: reasonLabel(e), phase: "patient" }
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
export const withLlmTimeout =
  (label?: string) =>
  <A, E, R>(eff: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    eff.pipe(
      Effect.timeoutFail({
        duration: Duration.millis(LLM_REQUEST_TIMEOUT_MS),
        onTimeout: () =>
          new AiError.UnknownError({
            module: "llm",
            method: "request",
            // Name the culprit — a surfaced timeout should read "kimi via
            // opencode is down", not an anonymous "request timed out".
            description: `request${label !== undefined ? ` to ${label}` : ""} timed out after ${Math.round(LLM_REQUEST_TIMEOUT_MS / 1000)}s`,
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
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    // The patient budget follows the run's interaction policy (RunContextRef —
    // seeded by the driver, inherited down the fleet); bare calls get 0.
    const rc = yield* FiberRef.get(RunContextRef)
    const budgetMs = patientBudgetFor(rc.interactionPolicy)
    return yield* retryWithBudget(eff, budgetMs)
  })

/**
 * Fast retries ONLY — for the helper tiers (session titles, compaction
 * digests, the approval judge, web search). They are best-effort work that
 * must never park a turn: the digest runs INLINE in the loop's append path, so
 * riding the main tier's 30-min patient ladder would stall the whole session
 * for a garnish. A helper that can't get through degrades gracefully instead.
 */
export const retryableLlmFast = <A, E, R>(
  eff: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => retryWithBudget(eff, 0)

const retryWithBudget = <A, E, R>(
  eff: Effect.Effect<A, E, R>,
  budgetMs: number,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const startMs = yield* Clock.currentTimeMillis

    // E is wider than AiError (a provider's generateText folds in toolkit-handler
    // errors), so retry stays polymorphic and only fires on a transient AiError;
    // every other failure propagates unchanged.
    const attempt = (n: number): Effect.Effect<A, E, R> =>
      eff.pipe(
        Effect.catchAll(
          (e: E) =>
            Effect.gen(function* () {
              const elapsedMs = (yield* Clock.currentTimeMillis) - startMs
              const d = planRetry(e, n, elapsedMs, budgetMs)
              if (!d.wait) return yield* Effect.fail(e)
              const patient = d.phase === "patient"
              yield* emitRetryNotice({
                reason: d.reason,
                attempt: n + 1,
                maxAttempts: MAX_RETRIES,
                delayMs: d.delayMs,
                // Present only on the patient ladder — consumers render
                // "provider down Nm — retrying" instead of "n/3".
                ...(patient ? { elapsedMs, budgetMs } : {}),
              })
              yield* Effect.annotateCurrentSpan({
                "llm.retry": true,
                "llm.retry.attempt": n + 1,
                "llm.retry.reason": d.reason,
                "llm.retry.delay_ms": d.delayMs,
                "llm.retry.phase": d.phase,
              })
              yield* Effect.logWarning(
                patient
                  ? `LLM ${d.reason} — provider unavailable ${Math.round(elapsedMs / 60_000)}m, retrying in ${Math.round(d.delayMs / 1000)}s (budget ${Math.round(budgetMs / 60_000)}m)`
                  : `LLM ${d.reason} — retrying in ${d.delayMs}ms (attempt ${n + 1}/${MAX_RETRIES})`,
              )
              yield* Effect.sleep(Duration.millis(d.delayMs))
              return yield* attempt(n + 1)
            }),
        ),
      )
    return yield* attempt(0)
  })
