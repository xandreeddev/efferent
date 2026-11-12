import { Match, Result } from "effect"
import type { StoredEvent } from "./event.entity.js"
import { TurnNumber } from "./ids.entity.js"
import type { SessionId } from "./ids.entity.js"
import { readJournal } from "./journal.entity.functions.js"
import type { UnknownRecord } from "./journal.entity.js"
import { JOURNAL_FORMAT, SessionRefused } from "./session.entity.js"
import type { Free, NewSession, SessionHeader, SessionState, TurnOpen } from "./session.entity.js"
import { KERNEL_READER, turnEndedEvent, turnStartedEvent } from "./vocabulary.entity.js"

/**
 * The state of a session nothing happened in yet.
 *
 * @public
 */
export const newSession: SessionState = { _tag: "Free", turns: 0 }

/** Open the next turn of a free session; a session with a turn open refuses with `SessionBusy`. */
export const beginTurn = (state: SessionState): Result.Result<TurnOpen, SessionRefused> =>
  Match.valueTags(state, {
    Free: ({ turns }): Result.Result<TurnOpen, SessionRefused> => Result.succeed({ _tag: "TurnOpen", turn: TurnNumber.make(turns + 1) }),
    TurnOpen: ({ turn }) => Result.fail(new SessionRefused({ reason: "SessionBusy", message: `turn ${turn} is still open` })),
  })

/**
 * Close the open turn; a free session refuses with `NoOpenTurn`.
 *
 * @public
 */
export const endTurn = (state: SessionState): Result.Result<Free, SessionRefused> =>
  Match.valueTags(state, {
    Free: () => Result.fail(new SessionRefused({ reason: "NoOpenTurn", message: "no turn is open" })),
    TurnOpen: ({ turn }): Result.Result<Free, SessionRefused> => Result.succeed({ _tag: "Free", turns: turn }),
  })

/**
 * A session's state as its journal tells it: the two transitions folded
 * over its `plugin.session.turn.started` and `plugin.session.turn.ended`
 * records. So the state can be rebuilt from storage alone. A journal the
 * transitions do not allow (a turn ended that never started) is refused as
 * they refuse it.
 */
export const sessionStateOf = (events: ReadonlyArray<StoredEvent>): Result.Result<SessionState, UnknownRecord | SessionRefused> => {
  const read = readJournal(KERNEL_READER)(events)
  if (Result.isFailure(read)) return Result.fail(read.failure)
  let state: SessionState = newSession
  for (const event of read.success) {
    const moved: Result.Result<SessionState, SessionRefused> =
      event.name === turnStartedEvent.name ? beginTurn(state) : event.name === turnEndedEvent.name ? endTurn(state) : Result.succeed(state)
    if (Result.isFailure(moved)) return Result.fail(moved.failure)
    state = moved.success
  }
  return Result.succeed(state)
}

/** The header a new session is stored with. */
export const headerOf = (id: SessionId, input: NewSession): SessionHeader => ({
  id,
  owner: input.owner,
  ...(input.parent === undefined ? {} : { parent: input.parent }),
  format: JOURNAL_FORMAT,
})
