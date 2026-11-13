// Lesson 3's experiments edit the learner's code in place, as lesson 2's do. A
// line the learner rewrote beyond recognition is left alone (None).
import { Option } from "effect"

/** Replace one exact piece of code, or None when it is not there. */
const swap = (from: string, to: string) => (source: string): Option.Option<string> =>
  source.includes(from) ? Option.some(source.replace(from, to)) : Option.none()

const ADDED = "            return [...context, { role: \"user\", content: `[Host note: it is ${time}.]` }]"

/** The wrong way: the clock stored as something the user said. It is sent again in every later request. */
export const storeClock = swap(ADDED, "            // Stored as a message: from now on, every request sends it, and every earlier one.\n            yield* session.append(userMessage(`[Host note: it is ${time}.]`))\n            return yield* memory.context(session)")

/** A careless wrapper: it drops the first message of the context it was given. */
export const dropFirst = swap(ADDED, "            return [...context.slice(1), { role: \"user\", content: `[Host note: it is ${time}.]` }]")

/** The meter's answer listener takes two seconds, and the turn waits for it (wait: true). */
export const slowMeter = swap(
  "        return Ref.update(spent, (n) => ({ turn: n.turn + tokens, total: n.total + tokens }))",
  "        return Ref.update(spent, (n) => ({ turn: n.turn + tokens, total: n.total + tokens })).pipe(\n          Effect.delay(\"2 seconds\"),\n        )",
)

/** main no longer provides the meter: nothing hooks the turn's events, and the status line keeps the last step. */
export const unplugMeter = swap("  Effect.provide(meter), // your event plugin: it counts what each turn cost\n", "")
