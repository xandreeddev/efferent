// Lesson 13's experiments edit the learner's code in place, so the code and
// the buttons never disagree. failures.ts is a list the experiment replaces
// whole; a piece of agent.ts the learner rewrote beyond recognition is left
// alone (None) rather than guessed at.
import { Option } from "effect"

/** Replace one exact piece of code, or None when it is not there. */
const swap = (from: string, to: string) => (source: string): Option.Option<string> =>
  source.includes(from) ? Option.some(source.replace(from, () => to)) : Option.none()

/** failures.ts as a list of the experiment's own, whatever it held. */
const listOf = (list: string) => (_source: string): Option.Option<string> => Option.some(list)

/** One failure worth another try, before anything: the starter list, put back. */
export const FAILS_ONCE = "[{ retryable: true }]"

/** One failure not worth another try: an unknown error, before anything. */
export const DOWN = "[{}]"

/** One failure worth another try, after a word of the answer was shown. */
export const CUT = '[{ retryable: true, pieces: ["Half "] }]'

/** Three failures not worth another try, one for each try a step without `while` makes. */
export const THREE_DOWN = "[{}, {}, {}]"

/** The `fails-once` experiment: failures.ts back to one failure worth another try. The rebuild starts the list again. */
export const failsOnce = listOf(FAILS_ONCE)

/** The `down` experiment: the picked model fails for good once, and the spare answers. */
export const down = listOf(DOWN)

/** The `cut` experiment: the answer starts, shows a word, and fails. */
export const cut = listOf(CUT)

/** The `no-while` experiment's failures.ts: three failures for good. */
export const threeDown = listOf(THREE_DOWN)

/** agent.ts's line that asks for the answer under the plan, through the kernel's `planned`. */
export const PLANNED_LINE = "          }).pipe(planned(plan)),\n"

/** The same line with Effect's plan alone: nothing holds that an answer is made once. */
export const PLAN_ALONE_LINE = "          }).pipe(Stream.withExecutionPlan(plan)),\n"

/** The `plan-alone` experiment's agent.ts: the call under Effect's plan, without `planned`. */
export const planAlone = swap(PLANNED_LINE, PLAN_ALONE_LINE)

/** The step's `while`, with its comment. */
export const WHILE = `    // Which failures are worth another try: a rate limit, a provider's own error, a lost
    // connection. Any other failure goes to the next step at once.
    while: retryable,
`

/** What the step says where its `while` was. */
export const NO_WHILE = "    // No while: every failure is tried again, as many times as attempts says.\n"

/** The `no-while` experiment's agent.ts: the first step tries every failure again. */
export const noWhile = swap(WHILE, NO_WHILE)
