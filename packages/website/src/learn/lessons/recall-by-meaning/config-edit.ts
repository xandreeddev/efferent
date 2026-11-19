// Lesson 20's controls and experiments edit memory.ts in place, so the code
// and the buttons never disagree: lesson 18's `limit` and `walk`, the list by
// meaning's `pool`, each a line of `withKnowledgeByMeaning({ … })(flatMemory)`,
// and the meaning list's weight, one number of the `weights` line. An
// experiment swaps one line. A line the learner rewrote beyond recognition is
// left alone (None). A value the kernel does not take (a pool of 0, a weight
// of 11) is written as it is: withKnowledgeByMeaning refuses it in its own
// words when the file runs.
import { Option } from "effect"
import type { LessonControl } from "../../lesson.ts"
import { numberControl, optionsOf, swap } from "../connected-memory/config-edit.ts"
import { WEIGHTS_LINE } from "./memory.source.ts"

const WRAPPER = "withKnowledgeByMeaning"
const options = optionsOf(WRAPPER)

/** The `weights` line, as memory.ts writes it: the three weights, in their order. */
const WEIGHTS = /^ {2}weights: \{ seed: ([\d.]+), words: ([\d.]+), meaning: ([\d.]+) \},$/

/** One weight of the `weights` line (`meaning`), read and written in place, the other two left as they are. */
const weightControl = (name: "seed" | "words" | "meaning"): LessonControl => {
  const at = { seed: 1, words: 2, meaning: 3 }[name]
  return {
    file: "memory",
    read: (source) => Option.flatMap(options(source), ({ lines }) => Option.firstSomeOf(lines.map((one) => Option.map(Option.fromNullishOr(WEIGHTS.exec(one)), (found) => Number(found[at]))))),
    write: (source, value) => Option.flatMap(options(source), (call) => {
      const index = call.lines.findIndex((one) => WEIGHTS.test(one))
      return index < 0 ? Option.none() : Option.some(call.with(call.lines.map((one, line) => {
        if (line !== index) return one
        const found = WEIGHTS.exec(one) ?? []
        const weights = { seed: found[1] ?? "1", words: found[2] ?? "0.5", meaning: found[3] ?? "1.5", [name]: String(value) }
        return `  weights: { seed: ${weights.seed}, words: ${weights.words}, meaning: ${weights.meaning} },`
      })))
    }),
  }
}

/** The page's controls, by `data-control` key: each writes one line of memory.ts's call, or one number of it. */
export const CONTROLS: Readonly<Record<string, LessonControl>> = {
  limit: numberControl("limit", WRAPPER),
  walk: numberControl("walk", WRAPPER),
  pool: numberControl("pool", WRAPPER),
  meaning: weightControl("meaning"),
}

/** memory.ts with the list by meaning off: lesson 18's recall, nothing embedded. */
export const MEANING_OFF = WEIGHTS_LINE.replace("meaning: 1.5 },", "meaning: 0 },")

/** The `meaning-off` experiment: the meaning list's weight at 0. */
export const meaningOff = swap(WEIGHTS_LINE, MEANING_OFF)

/** memory.ts with the list your words reach off: the list about a seed and the list by meaning alone. */
export const WORDS_OFF = WEIGHTS_LINE.replace("words: 0.5,", "words: 0,")

/** The `words-off` experiment: the words list's weight at 0. */
export const wordsOff = swap(WEIGHTS_LINE, WORDS_OFF)

/** memory.ts with a floor under the list by meaning: a memory less like your message than this is not in it. */
export const FLOOR_LINE = `${WEIGHTS_LINE}
  // The least cosine a memory needs to be in the list by meaning, from 0 to 1: a number of one
  // embedder's, which says nothing of another's.
  floor: 0.77,`

/** The `floor` experiment: a floor of 0.77 under the list by meaning. */
export const floorOn = swap(WEIGHTS_LINE, FLOOR_LINE)
