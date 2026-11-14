// Lesson 7's experiments edit the learner's code in place, so the code and
// the page never disagree. A line the learner rewrote beyond recognition is
// left alone (None) rather than guessed at.
import { Option } from "effect"

/** Replace one exact piece of code, or None when it is not there. */
const swap = (from: string, to: string) => (source: string): Option.Option<string> =>
  source.includes(from) ? Option.some(source.replace(from, to)) : Option.none()

/** chat.ts goes on with the last conversation and never closes the turn a page that is gone left open in it. */
export const noRecover = swap("  yield* sessions.recover(last.id)\n", "")

/** The store's place check, as store.ts writes it. */
const PLACE_CHECK = `            if (behind || taken)
              return refused("SeqConflict", \`the journal is not at \${expectedSeq}\`)
`

/** store.ts appends wherever it is told: nothing checks that the place before is taken and this one free. */
export const noPlaceCheck = swap(PLACE_CHECK, "")

/** Where store.ts keeps the events, as it writes it. */
const KEPT = `  // Where the events are kept: the same storage as the headers.
  const kept = storage
`

/** store.ts keeps the headers in the storage and the events in the page's memory: they are gone with the page. */
export const forgetsEvents = swap(KEPT, `  // Where the events are kept: in this page's memory. The headers outlive the page, the events do not.
  const memory = new Map()
  const kept = {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, value),
  }
`)
