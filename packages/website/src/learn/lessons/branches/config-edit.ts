// Lesson 15's experiments edit the learner's code in place, so the code and
// the page never disagree. A line the learner rewrote beyond recognition is
// left alone (None) rather than guessed at.
import { Option } from "effect"
import { FORK_AT_TURN } from "./branch.source.ts"
import { ASKED } from "./chat.source.ts"

/** Replace one exact piece of code, or None when it is not there. */
const swap = (from: string, to: string) => (source: string): Option.Option<string> =>
  source.includes(from) ? Option.some(source.replace(from, to)) : Option.none()

/** branchFrom names no turn: the sessions cut at the end of the last closed turn, whichever button was pressed. */
export const latest = swap(FORK_AT_TURN, `    // No turn named: the cut is at the end of the last closed turn.
    return yield* sessions.fork(conversation)
`)

/** branchFrom asks for the turn after the one pressed: a turn still open, or one that never was. */
export const openTurn = swap(FORK_AT_TURN, `    // The turn after the one you pressed: still open, or never begun.
    return yield* sessions.fork(conversation, { through: TurnNumber.make(turn + 1) })
`)

/** resume goes back to lesson 7's rule: the last of your chats, whichever the page asks for. */
export const resumeIgnores = swap(ASKED, `  // The last one, as in lesson 7: chosen is never read.
  const shown = mine.at(-1)
`)
