// Lesson 5's controls and experiments edit the learner's code in place, so
// the code and the controls never disagree. A line the learner rewrote
// beyond recognition is left alone (None) rather than guessed at.
import { Option } from "effect"

const budgetLine = /(budgetTokens: )(\d+)/
const keepLine = /(keepTurns: )(\d+)/

/** memory.ts's budget: how many tokens of history fit. */
export const readBudget = (memory: string): Option.Option<number> =>
  Option.map(Option.fromNullishOr(budgetLine.exec(memory)?.[2]), Number)

export const writeBudget = (memory: string, tokens: number): Option.Option<string> =>
  budgetLine.test(memory) && Number.isInteger(tokens) && tokens >= 1
    ? Option.some(memory.replace(budgetLine, (_all, head: string) => `${head}${tokens}`))
    : Option.none()

/** memory.ts keeping no finished turn whole: the summary and the turn being answered, nothing between. */
export const keepNone = (memory: string): Option.Option<string> =>
  keepLine.test(memory) ? Option.some(memory.replace(keepLine, (_all, head: string) => `${head}0`)) : Option.none()

/** The budget at which this lesson's Echo conversation compacts on nearly every turn. */
export const EVERY_TURN_BUDGET = 100

/** summarizer.ts failing whatever it is asked: the turn's context fails with it. */
export const failingSummarizer = (summarizer: string): Option.Option<string> => {
  const from = /      summarize: \(\{ earlier, messages \}\) => \{[\s\S]*?\n      \},\n/
  return from.test(summarizer)
    ? Option.some(summarizer.replace(from, `      summarize: () => Effect.fail(new SummaryFailed({ message: "the summarizer is out of order" })),\n`))
    : Option.none()
}
