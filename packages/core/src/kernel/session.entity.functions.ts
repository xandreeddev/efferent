import { Match, Result } from "effect"
import { TurnNumber } from "./ids.entity.js"
import { SessionRefused } from "./session.entity.js"
import type { Free, SessionState, TurnOpen } from "./session.entity.js"

/** Open the next turn of a free session; a session with a turn open refuses with `SessionBusy`. */
export const beginTurn = (state: SessionState): Result.Result<TurnOpen, SessionRefused> =>
  Match.valueTags(state, {
    Free: ({ turns }): Result.Result<TurnOpen, SessionRefused> => Result.succeed({ _tag: "TurnOpen", turn: TurnNumber.make(turns + 1) }),
    TurnOpen: ({ turn }) => Result.fail(new SessionRefused({ reason: "SessionBusy", message: `turn ${turn} is still open` })),
  })

/** Close the open turn; a free session refuses with `NoOpenTurn`. */
export const endTurn = (state: SessionState): Result.Result<Free, SessionRefused> =>
  Match.valueTags(state, {
    Free: () => Result.fail(new SessionRefused({ reason: "NoOpenTurn", message: "no turn is open" })),
    TurnOpen: ({ turn }): Result.Result<Free, SessionRefused> => Result.succeed({ _tag: "Free", turns: turn }),
  })
