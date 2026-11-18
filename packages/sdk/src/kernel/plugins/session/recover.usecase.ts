import { Effect, Option, Result } from "effect"
import { currentFormat, Sessions } from "@xandreed/core/kernel"
import type { TurnFailure } from "@xandreed/core/kernel"
import type { RecoveredTurn } from "./recover.entity.js"

/**
 * The host's recovery step for a store it has just taken as its one writer
 * (ADR 0024): every turn the store holds open is a dead writer's, since no
 * writer but this process can have opened it, so each is closed with
 * `Sessions.recover`, which stores `core.session.turn.ended` with the outcome
 * `Abandoned`. Every session of the store is looked at, in the order of
 * `Sessions.list`: a conversation, a helper's or a task's session, and the
 * sessions plugins keep of their own (facts, a graph, knowledge). A session
 * written in another journal format is passed over, as a host passes over
 * such a conversation. Gives the turns it closed.
 *
 * Run it once, after the store's layer is built and before any turn: the
 * kernel never runs it (ADR 0010), and run while a turn of this process is
 * open it is refused there (`SessionBusy`).
 *
 * @public
 */
export const recoverTurns: Effect.Effect<ReadonlyArray<RecoveredTurn>, TurnFailure, Sessions> = Effect.gen(function* () {
  const sessions = yield* Sessions
  const readable = (yield* sessions.list).filter((header) => Result.isSuccess(currentFormat(header)))
  const closed = yield* Effect.forEach(readable, (header) =>
    Effect.map(sessions.recover(header.id), Option.map((turn): RecoveredTurn => ({ session: header.id, turn }))), { concurrency: 1 })
  return closed.flatMap(Option.toArray)
}).pipe(Effect.withSpan("kernel.session.recover_turns"))
