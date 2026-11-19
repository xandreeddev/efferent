import { Effect, Option, Result } from "effect"
import type { Context } from "effect"
import { currentFormat, Sessions } from "@xandreed/core"
import type { JournalStorageError, SessionId, TurnFailure } from "@xandreed/core"
import type { Recovery, RecoveredTurn, UnreadableSession } from "./recover.entity.js"

/** What became of one session: a turn closed, nothing to close, or a session the store could not read. */
type Outcome =
  | { readonly _tag: "Closed"; readonly turn: RecoveredTurn }
  | { readonly _tag: "Free" }
  | { readonly _tag: "Unreadable"; readonly session: UnreadableSession }

/** One session recovered; the store's `Unreadable` is the session's outcome, any other failure the step's. */
const recoverOne = (sessions: Context.Service.Shape<typeof Sessions>, id: SessionId): Effect.Effect<Outcome, TurnFailure> => sessions.recover(id).pipe(
  Effect.map(Option.match({
    onNone: (): Outcome => ({ _tag: "Free" }),
    onSome: (turn): Outcome => ({ _tag: "Closed", turn: { session: id, turn } }),
  })),
  Effect.catchIf(
    (error): error is JournalStorageError => error._tag === "JournalStorageError" && error.reason === "Unreadable",
    (error) => Effect.as(
      Effect.logWarning(`recoverTurns passed over session ${id}, which the store cannot read: ${error.message}`),
      { _tag: "Unreadable", session: { session: id, message: error.message } } satisfies Outcome,
    ),
  ),
)

/**
 * The host's recovery step for a store it has just taken as its one writer
 * (ADR 0024): every turn the store holds open is a dead writer's, since no
 * writer but this process can have opened it, so each is closed with
 * `Sessions.recover`, which stores `core.session.turn.ended` with the outcome
 * `Abandoned`. Every session of the store is looked at, in the order of
 * `Sessions.list`: a conversation, a helper's or a task's session, and the
 * sessions plugins keep of their own (facts, knowledge). A session
 * written in another journal format is passed over, as a host passes over
 * such a conversation. A session the store cannot read (`Unreadable`: a
 * damaged line) is passed over too, logged and given in `unreadable`, and the
 * sessions after it are recovered all the same; any other failure of the
 * store (`Unavailable`) fails the step. Gives the turns it closed and the
 * sessions it could not read (`Recovery`).
 *
 * Run it once per process, by the code that opened the store, after the
 * store's layer is built and before any turn: the kernel never runs it (ADR
 * 0010). A turn this `Sessions` holds open is refused there (`SessionBusy`);
 * one another stack of the same process holds open is not known to it, and
 * would be closed as `Abandoned`.
 *
 * @public
 */
export const recoverTurns: Effect.Effect<Recovery, TurnFailure, Sessions> = Effect.gen(function* () {
  const sessions = yield* Sessions
  const readable = (yield* sessions.list).filter((header) => Result.isSuccess(currentFormat(header)))
  const outcomes = yield* Effect.forEach(readable, (header) => recoverOne(sessions, header.id), { concurrency: 1 })
  return {
    closed: outcomes.flatMap((outcome) => (outcome._tag === "Closed" ? [outcome.turn] : [])),
    unreadable: outcomes.flatMap((outcome) => (outcome._tag === "Unreadable" ? [outcome.session] : [])),
  }
}).pipe(Effect.withSpan("session.recover_turns"))
