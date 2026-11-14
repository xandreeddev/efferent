// Lesson 3's experiments edit the learner's code in place, as lesson 2's do. A
// line the learner rewrote beyond recognition is left alone (None).
import { Option } from "effect"

/** Replace one exact piece of code, or None when it is not there. */
const swap = (from: string, to: string) => (source: string): Option.Option<string> =>
  source.includes(from) ? Option.some(source.replace(from, to)) : Option.none()

const ADDED = "            return [...context, { role: \"user\", content: hostNote(`it is ${time}.`) }]"

/** The clock's body as plugin.ts has it: the context asked for first, then the time, then the note added after it. */
const BODY = [
  "            const context = yield* memory.context(session)",
  "            // Computed here, like the system text, and never stored: the next request gets its own.",
  "            const now = new Date(yield* Clock.currentTimeMillis)",
  "            const time = now.toLocaleTimeString([], { hour: \"2-digit\", minute: \"2-digit\" })",
  ADDED,
].join("\n")

/**
 * The wrong way: the clock stored as something the user said, before the memory is asked, so the memory sends it
 * from the journal, in this request and every later one. The memory is still asked once.
 */
export const storeClock = swap(BODY, [
  "            const now = new Date(yield* Clock.currentTimeMillis)",
  "            const time = now.toLocaleTimeString([], { hour: \"2-digit\", minute: \"2-digit\" })",
  "            // The wrong way: stored as something you said. Every later request sends it again.",
  "            yield* session.append(userMessage(hostNote(`it is ${time}.`)))",
  "            return yield* memory.context(session)",
].join("\n"))

/** A careless wrapper: it drops the first message of the context it was given. */
export const dropFirst = swap(ADDED, "            return [...context.slice(1), { role: \"user\", content: hostNote(`it is ${time}.`) }]")

/** The meter's answer listener takes two seconds, and the turn waits for it (wait: true). */
export const slowMeter = swap(
  "        return Ref.update(spent, (n) => ({ turn: n.turn + tokens, total: n.total + tokens }))",
  "        return Ref.update(spent, (n) => ({ turn: n.turn + tokens, total: n.total + tokens })).pipe(\n          Effect.delay(\"2 seconds\"),\n        )",
)

/** main no longer provides the meter: nothing hooks the turn's events, and the status line keeps the last step. */
export const unplugMeter = swap("  Effect.provide(meter), // your event plugin: it counts what each turn cost\n", "")
