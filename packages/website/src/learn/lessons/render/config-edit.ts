// Lesson 6's experiments edit the learner's code in place. A line the
// learner rewrote beyond recognition is left alone (None) rather than guessed at.
import { Option } from "effect"
import { withoutTurn } from "./agent.source.ts"

const swap = (from: string, to: string) => (source: string): Option.Option<string> =>
  source.includes(from) ? Option.some(source.replace(from, to)) : Option.none()

/** Each row takes half a second: watch the progress bar, and Stop it halfway. */
export const slowShow = swap(
  "      for (let i = 1; i <= count; i++) {\n",
  "      for (let i = 1; i <= count; i++) {\n        yield* Effect.sleep(\"500 millis\")\n",
)

/** The wrong way: the tool returns the table itself, which the model reads in every later request. */
export const tableAsResult = swap("      return `shown as ${id}`", "      return [columns, ...rows].map((cells) => cells.join(\" | \")).join(\"\\n\")")

/** The loop gives a call no turn: show, which needs one, fails, and the model reads why. */
export const noTurn = (agent: string): Option.Option<string> => {
  const changed = withoutTurn(agent)
  return changed === agent ? Option.none() : Option.some(changed)
}
