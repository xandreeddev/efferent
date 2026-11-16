// Lesson 17's experiments edit the learner's code in place, so the code and
// the buttons never disagree: a helper that answers at once, and a plugin that
// runs one task at a time. A line the learner rewrote beyond recognition is
// left alone (None) rather than guessed at.
import { Option } from "effect"
import { TASKS_LINE } from "./agent.source.ts"
import { WAIT } from "./helper.source.ts"

/** Replace one exact piece of code, or None when it is not there. */
const swap = (from: string, to: string) => (source: string): Option.Option<string> =>
  source.includes(from) ? Option.some(source.replace(from, () => to)) : Option.none()

/** helper.ts with no wait: the helper answers at once, and its report comes right behind the turn that started it. */
export const instant = swap(WAIT, "")

/** main's line with the plugin's bound: at most one task runs at once. */
export const ONE_AT_A_TIME_LINE = "  Effect.provide(tasks(helper, { running: 1 })), // at most one task runs at once\n"

/** agent.ts whose tasks plugin runs one task at a time: a second is refused in the kernel's words. */
export const oneAtATime = swap(TASKS_LINE, ONE_AT_A_TIME_LINE)
