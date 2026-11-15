// Lesson 10's experiments edit the learner's code in place, so the code and
// the buttons never disagree. A line the learner rewrote beyond recognition
// is left alone (None) rather than guessed at.
import { Option } from "effect"
import { OFFERED, SYSTEM, UNITS_LINE } from "./agent.source.ts"

/** Replace one exact piece of code, or None when it is not there. */
const swap = (from: string, to: string) => (source: string): Option.Option<string> =>
  source.includes(from) ? Option.some(source.replace(from, () => to)) : Option.none()

/** The system text with both skills' instructions in it, and no catalogue: there is nothing left to load. */
export const SYSTEM_WITH_INSTRUCTIONS = `// Every skill's instructions are in the system text, in every prompt: there is nothing to load,
// so there is no catalogue.
const system = \`\${opening}\\n\\n\${units.instructions}\\n\\n\${haiku.instructions}\`
`

/** The loop's toolkit when every tool is offered at every step. */
export const WHOLE_TOOLKIT = `        // Every tool is offered at every step, whatever is loaded: the whole toolkit.
        const toolkit = yield* skillSet.toolkit
`

/** agent.ts with everything always on: the instructions in the system text, and every tool offered from the first step. */
export const alwaysOn = (agent: string): Option.Option<string> =>
  Option.flatMap(swap(SYSTEM, SYSTEM_WITH_INSTRUCTIONS)(agent), swap(OFFERED, WHOLE_TOOLKIT))

/** The system text that names no skill. */
export const SYSTEM_ALONE = `// The catalogue is left out: nothing tells the model that it has skills, or what they are.
const system = opening
`

/** agent.ts whose system text has no catalogue: the skills are there, and the model is not told. */
export const noCatalogue = swap(SYSTEM, SYSTEM_ALONE)

/** What main says where the units skill's handlers were. */
export const NO_UNITS_LINE = "  // The units skill's handlers are not given here: nothing can run its tool.\n"

/** agent.ts whose main leaves out the units skill's handlers: the page runs it, and TypeScript would refuse it. */
export const noHandlers = swap(UNITS_LINE, NO_UNITS_LINE)
