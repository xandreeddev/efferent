import { AiError } from "@effect/ai"
import { Effect } from "effect"
import { isTransientAiError } from "./retry.js"

/**
 * Per-provider circuit breaker for LLM calls.
 *
 * When a provider is consistently failing (revoked key, deprecated model,
 * sustained outage), retrying every call wastes tokens and burns rate limits.
 * The breaker opens after a threshold of transient failures within a window,
 * then fails fast for a cooldown period before half-opening.
 */

/** Threshold: open after this many transient failures in the window. */
const FAILURE_THRESHOLD = 5
/** Window: failures must occur within this many ms to count toward opening. */
const FAILURE_WINDOW_MS = 30_000
/** Cooldown: how long the circuit stays open before half-opening. */
const COOLDOWN_MS = 15_000

interface CircuitState {
  state: "closed" | "open" | "half-open"
  failures: ReadonlyArray<number> // timestamps of recent failures
  openedAt: number | undefined
}

const circuits = new Map<string, CircuitState>()

const key = (provider: string, modelId: string): string => `${provider}:${modelId}`

const now = (): number => Date.now()

const getState = (k: string): CircuitState => {
  const existing = circuits.get(k)
  if (existing !== undefined) return existing
  const fresh: CircuitState = { state: "closed", failures: [], openedAt: undefined }
  circuits.set(k, fresh)
  return fresh
}

/**
 * Trim failure timestamps to only those within the window, then decide if the
 * threshold is crossed.
 */
const shouldOpen = (failures: ReadonlyArray<number>): boolean => {
  const cutoff = now() - FAILURE_WINDOW_MS
  const recent = failures.filter((t) => t >= cutoff)
  return recent.length >= FAILURE_THRESHOLD
}

/**
 * Report a failure to the circuit. Returns the new state.
 */
const recordFailure = (k: string): CircuitState => {
  const current = getState(k)
  const cutoff = now() - FAILURE_WINDOW_MS
  const recent = [...current.failures.filter((t) => t >= cutoff), now()]
  if (current.state === "half-open" || shouldOpen(recent)) {
    const openState: CircuitState = { state: "open", failures: recent, openedAt: now() }
    circuits.set(k, openState)
    return openState
  }
  const updated: CircuitState = { ...current, failures: recent }
  circuits.set(k, updated)
  return updated
}

/**
 * Report a success to the circuit — closes it.
 */
const recordSuccess = (k: string): void => {
  circuits.set(k, { state: "closed", failures: [], openedAt: undefined })
}

/**
 * Check whether the circuit is currently open (and still cooling down).
 * If the cooldown has elapsed, transitions to half-open automatically.
 */
const checkCircuit = (k: string): { open: boolean; state: CircuitState } => {
  const current = getState(k)
  if (current.state === "closed") return { open: false, state: current }
  if (current.state === "half-open") return { open: false, state: current }
  // state === "open"
  if (current.openedAt === undefined) {
    // Defensive: should never happen, but treat as half-open.
    const half: CircuitState = { ...current, state: "half-open" }
    circuits.set(k, half)
    return { open: false, state: half }
  }
  if (now() - current.openedAt >= COOLDOWN_MS) {
    const half: CircuitState = { ...current, state: "half-open" }
    circuits.set(k, half)
    return { open: false, state: half }
  }
  return { open: true, state: current }
}

/** Human-readable message for an open circuit. */
const circuitOpenMessage = (provider: string, modelId: string): string =>
  `Circuit breaker OPEN for ${provider}/${modelId} — the provider has failed ` +
  `${FAILURE_THRESHOLD}+ times in ${Math.round(FAILURE_WINDOW_MS / 1000)}s. ` +
  `Waiting ${Math.round(COOLDOWN_MS / 1000)}s before retrying. ` +
  `Check your API key, model id, or provider status.`

/**
 * Wrap an LLM Effect with circuit-breaker logic.
 *
 * The breaker is keyed by provider+model. On each transient failure, the
 * failure is recorded; on non-transient failure or success, the circuit is
 * closed. When open, the Effect fails fast with a clear message instead of
 * burning retries.
 *
 * `makeOpenError` constructs the error value for an open-circuit so the
 * return type stays `E` (no error widening).
 */
export const withCircuitBreaker = <A, E, R>(
  eff: Effect.Effect<A, E, R>,
  provider: string,
  modelId: string,
  makeOpenError: (message: string) => E,
): Effect.Effect<A, E, R> => {
  const k = key(provider, modelId)
  return Effect.gen(function* () {
    const check = checkCircuit(k)
    if (check.open) {
      return yield* Effect.fail(makeOpenError(circuitOpenMessage(provider, modelId)))
    }

    const result = yield* eff.pipe(
      Effect.tap(() => {
        recordSuccess(k)
        return Effect.void
      }),
      Effect.catchAll((e: E) => {
        if (AiError.isAiError(e) && isTransientAiError(e)) {
          const newState = recordFailure(k)
          if (newState.state === "open") {
            return Effect.fail(makeOpenError(circuitOpenMessage(provider, modelId)))
          }
        }
        // Non-transient failure: don't record, just propagate.
        return Effect.fail(e)
      }),
    )
    return result
  })
}
