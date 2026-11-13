// Lesson 2's controls and experiments edit the learner's code in place, so
// the code and the controls never disagree. A line the learner rewrote
// beyond recognition is left alone (None) rather than guessed at.
import { Option } from "effect"

const stepsLine = /(const MAX_STEPS = )(\d+)/

/** How many times one turn may call the model. */
export const readMaxSteps = (agent: string): Option.Option<number> =>
  Option.map(Option.fromNullishOr(stepsLine.exec(agent)?.[2]), Number)

export const writeMaxSteps = (agent: string, steps: number): Option.Option<string> =>
  stepsLine.test(agent) && Number.isInteger(steps) && steps >= 1
    ? Option.some(agent.replace(stepsLine, (_all, head: string) => `${head}${steps}`))
    : Option.none()

/** Replace one exact piece of code, or None when it is not there. */
const swap = (from: string | RegExp, to: string) => (source: string): Option.Option<string> =>
  (typeof from === "string" ? source.includes(from) : from.test(source)) ? Option.some(source.replace(from, to)) : Option.none()

/** The calculator's answer, as tools.ts computes it. */
const ANSWER = `Effect.succeed({ "+": a + b, "-": a - b, "*": a * b, "/": a / b }[op])`

/** The calculator fails, whatever it is asked: the model reads the failure as its answer. */
export const brokenCalculator = swap(/  calculator: \(\{ a, op, b \}\) =>[\s\S]*?\}\[op\]\),\n/, `  calculator: () => Effect.fail("the calculator is out of order"),\n`)

/** The calculator takes four seconds: time to send a message while the turn works. */
export const slowCalculator = swap(`: ${ANSWER},`, `: ${ANSWER}.pipe(Effect.delay("4 seconds")),`)

/** The turn no longer takes the messages sent while it works: they wait for their own turn. */
export const withoutSteering = swap(/\n\n\s*\/\/ Messages you sent while it worked steer it[^\n]*\n[^\n]*\n\s*if \(step < MAX_STEPS\) \{\n\s*const steers = yield\* chat\.drain\n\s*for \(const steer of steers\) \{\n\s*yield\* session\.append\(userMessage\(steer\)\)\n\s*\}\n\s*\}/, "")
