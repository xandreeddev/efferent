// Lesson 12's experiments edit the learner's code in place, so the code and
// the buttons never disagree. A piece the learner rewrote beyond recognition
// is left alone (None) rather than guessed at.
import { Option } from "effect"
import { LIST_END, LIST_INTRO } from "./checks.source.ts"

/** Replace one exact piece of code, or None when it is not there. */
const swap = (from: string, to: string) => (source: string): Option.Option<string> =>
  source.includes(from) ? Option.some(source.replace(from, () => to)) : Option.none()

/** The calculator's sum, as tools.ts works it out. */
const SUM = `{ "+": a + b,`

/** The same piece with the bug: it subtracts where it should add. */
export const BROKEN_SUM = `{ "+": a - b,`

/** The `break-calculator` experiment: tools.ts with a calculator that subtracts where it should add. */
export const breakCalculator = swap(SUM, BROKEN_SUM)

/** Checks added to the end of the list, or None when the list no longer ends as it did or already holds them. */
const added = (checks: string) => (source: string): Option.Option<string> =>
  source.endsWith(LIST_END) && !source.includes(checks) ? Option.some(`${source.slice(0, -1)}${checks}]`) : Option.none()

/** The two checks the `vacuous` experiment adds: one that asks something of every call over a script that makes none, and the form that counts first, over the same script. */
export const VACUOUS = `  // A check that checks nothing. Its script makes no call, and its holds asks something of every
  // call: with none to ask it of, nothing is wrong.
  check(
    "every-call",
    "every call's result is 5",
    [{ _tag: "Answers", pieces: ["It is 5."] }],
    ["What is 2 + 3?"],
    (turns) => {
      for (const call of callsOf(turns)) {
        const result = Option.getOrUndefined(call.result)
        if (result === undefined || result.result !== 5) return \`\${call.name} did not answer 5\`
      }
      return undefined
    },
  ),
  // The honest form, over the same script: calculated counts the calls before it reads them.
  check(
    "one-call",
    "one call was made, and its result is 5",
    [{ _tag: "Answers", pieces: ["It is 5."] }],
    ["What is 2 + 3?"],
    (turns) => calculated(turns, 5),
  ),
`

/** The `vacuous` experiment: checks.ts with a check that passes and checks nothing, and its honest form beside it. */
export const vacuous = added(VACUOUS)

/** The function the `live` experiment adds above the list: a check on the model picked, run several times. */
export const LIVE = `// A live check: the program on the model you picked, with no script. model comes from the page,
// as it does in agent.ts. A model does not answer the same way every time, so the check runs
// several times and says how many runs passed. That is a rate, and every run costs model calls.
const live = (id, name, runs, messages, holds) => ({
  id,
  name,
  run: Effect.gen(function* () {
    let passed = 0
    let first
    for (let run = 1; run <= runs; run++) {
      const turns = yield* Effect.orDie(turnsAfter(model, messages))
      const wrong = holds(turns)
      if (wrong === undefined) passed++
      // A rate alone does not say what went wrong: keep the words of the first run that failed.
      else first = first ?? wrong
    }
    const rate = \`\${passed} of \${runs} runs passed\`
    // Every run must pass. One that does not fails the check, with the rate and the first miss.
    if (passed < runs)
      yield* Effect.fail(
        new ConformanceFailure({ check: id, message: \`\${rate}. The first that did not: \${first}\` }),
      )
    return rate
  }),
})

`

/** The check the `live` experiment adds to the end of the list: the sum, five times, on the model picked. */
export const LIVE_CHECK = `  live(
    "live-sum",
    "the model you picked works out 2 + 3 with the calculator",
    5,
    ["What is 2 + 3?"],
    (turns) => calculated(turns, 5),
  ),
`

/** The `live` experiment: checks.ts with `live` above the list and one live check at its end, both or neither. */
export const withLive = (source: string): Option.Option<string> =>
  source.includes(LIVE) ? Option.none() : Option.flatMap(swap(LIST_INTRO, `${LIVE}${LIST_INTRO}`)(source), added(LIVE_CHECK))
