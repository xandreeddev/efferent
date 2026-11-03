import { Effect, Option } from "effect"
import { CommittedTurnObservers } from "../ports/committed-turn-observers.port.js"
import { COMMITTED_TURN_OBSERVER_TIMEOUT_MS } from "./committed-turn.entity.js"
import type { CommittedTurn } from "./committed-turn.entity.js"

/**
 * Notify observers sequentially after a successful authoritative end.
 * Each receives an independent snapshot; failures and timeouts are logged.
 * Hosts ending borrowed writers call this after their own writer.end.
 * @public
 */
export const notifyCommittedTurn = Effect.fnUntraced(function* (turn: CommittedTurn) {
  const observers = yield* Effect.serviceOption(CommittedTurnObservers)
  if (Option.isNone(observers) || observers.value.length === 0) return
  yield* Effect.forEach(observers.value, (observer) =>
    Effect.suspend(() => observer.committed({ ...turn, session: { ...turn.session } })).pipe(
      Effect.interruptible,
      Effect.timeoutOption(COMMITTED_TURN_OBSERVER_TIMEOUT_MS),
      Effect.flatMap((result) => Option.isNone(result)
        ? Effect.logWarning("a committed-turn observer timed out; its durable source remains available for catch-up", { observer: observer.id })
        : Effect.void),
      Effect.catchCause((cause) => Effect.logWarning("a committed-turn observer did not finish; its durable source remains available for catch-up", { observer: observer.id }, cause)),
    ), { concurrency: 1, discard: true }).pipe(Effect.withSpan("turn.committed"))
})
