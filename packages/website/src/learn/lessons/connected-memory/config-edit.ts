// Lesson 18's controls and experiments edit the learner's files in place, so
// the code and the buttons never disagree. The controls each read and write
// one option of memory.ts's `withKnowledge({ … })(flatMemory)` call, a line of
// its own; an experiment swaps one line. A piece the learner rewrote beyond
// recognition is left alone (None) rather than guessed at. A value the kernel
// does not take (a limit of 0, a walk of 11) is written as it is:
// withKnowledge refuses it in its own words when the file runs.
import { Option } from "effect"
import type { LessonControl } from "../../lesson.ts"
import { REVIEW_LINE } from "./curator.source.ts"
import { WALK_LINE } from "./memory.source.ts"

/** Replace one exact piece of code, or None when it is not there. */
const swap = (from: string, to: string) => (source: string): Option.Option<string> =>
  source.includes(from) ? Option.some(source.replace(from, () => to)) : Option.none()

/** The one call of memory.ts, its options a line each between `withKnowledge({` and `})(flatMemory)`. */
const CALL = /^export const memory = withKnowledge\(\{\n((?:.*\n)*?)\}\)\(flatMemory\)$/m

/** The call's option lines, comments included, and how to write the file with other ones; None when the call is not there. */
const optionsOf = (source: string): Option.Option<{ readonly lines: ReadonlyArray<string>; readonly with: (lines: ReadonlyArray<string>) => string }> =>
  Option.map(Option.fromNullishOr(CALL.exec(source)), (found) => ({
    lines: (found[1] ?? "").split("\n").slice(0, -1),
    with: (lines) => source.replace(CALL, () => `export const memory = withKnowledge({\n${lines.map((line) => `${line}\n`).join("")}})(flatMemory)`),
  }))

/** A whole number's option (`  limit: 8,`), read and written in place. */
const numberControl = (name: string): LessonControl => {
  const line = new RegExp(`^  ${name}: (\\d+),$`)
  return {
    file: "memory",
    read: (source) => Option.flatMap(optionsOf(source), ({ lines }) => Option.firstSomeOf(lines.map((one) => Option.map(Option.fromNullishOr(line.exec(one)), (found) => Number(found[1]))))),
    write: (source, value) => Option.flatMap(optionsOf(source), (call) => {
      const at = call.lines.findIndex((one) => line.test(one))
      return at < 0 ? Option.none() : Option.some(call.with(call.lines.map((one, index) => (index === at ? `  ${name}: ${String(value)},` : one))))
    }),
  }
}

/** The two controls of the page, by `data-control` key: each writes one line of memory.ts's call. */
export const CONTROLS: Readonly<Record<string, LessonControl>> = {
  limit: numberControl("limit"),
  walk: numberControl("walk"),
}

/** memory.ts with no walk by subject: the starter with `walk: 0`. */
export const WALK_ZERO = WALK_LINE.replace("walk: 3,", "walk: 0,")

/** The `walk-zero` experiment: the memories ranked first alone, and none the walk by subject would add. */
export const walkZero = swap(WALK_LINE, WALK_ZERO)

/** curator.ts with the second call: the curator's reply is checked by a review before it is stored. */
export const REVIEW_ON = REVIEW_LINE.replace("const options = { review: false }", "const options = { review: true }")

/** The `review-on` experiment: two model calls for each turn, not one. */
export const reviewOn = swap(REVIEW_LINE, REVIEW_ON)
