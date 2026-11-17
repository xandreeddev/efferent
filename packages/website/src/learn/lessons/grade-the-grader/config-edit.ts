// Lesson 19's experiments edit the learner's code in place, so the code and
// the buttons never disagree. A piece the learner rewrote beyond recognition
// is left alone (None) rather than guessed at.
import { Option } from "effect"
import { COMMITS_BAR, ONCE_BAR } from "./graders.source.ts"
import { HEDGE_LABEL, LABELS_END } from "./labels.source.ts"

/** Replace one exact piece of code, or None when it is not there. */
const swap = (from: string, to: string) => (source: string): Option.Option<string> =>
  source.includes(from) ? Option.some(source.replace(from, () => to)) : Option.none()

/** Case 4's label as the `hedge-is-wrong` experiment leaves it: a hedged answer is wrong. */
export const HEDGE_WRONG = `    // A person changed this label: a hedged answer is wrong, even when its number is right.
    label: false,
`

/** The `hedge-is-wrong` experiment: case 4's label becomes false. */
export const hedgeIsWrong = swap(HEDGE_LABEL, HEDGE_WRONG)

/** The `commit-lower` experiment: asked-thrice passes an answer that commits with a probability of 0.25 or more. */
export const commitLower = swap(COMMITS_BAR, "const THRICE_COMMITS = 0.25")

/** The `once-stricter` experiment: asked-once passes an answer that gives the reference with a probability of 0.8 or more. */
export const onceStricter = swap(ONCE_BAR, "const ONCE_GIVES = 0.8")

/** The case the `your-own-case` experiment adds: a ninth, of the learner's own, which Jev was never asked. */
export const OWN_CASE = `  {
    id: "9",
    question: "How many legs does a spider have?",
    reference: "8",
    answer: "Eight.",
    // You wrote this label: right, the number in words.
    label: true,
  },
`

/** The `your-own-case` experiment: the ninth case, at the end of the list, once. */
export const yourOwnCase = (source: string): Option.Option<string> =>
  source.includes(OWN_CASE) || !source.endsWith(LABELS_END) ? Option.none() : Option.some(`${source.slice(0, -1)}${OWN_CASE}]`)
