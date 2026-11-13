// Lesson 4's experiments edit the learner's code in place, as the earlier
// lessons' do. A line the learner rewrote beyond recognition is left alone.
import { Option } from "effect"

/** Replace one exact piece of code, or None when it is not there. */
const swap = (from: string, to: string) => (source: string): Option.Option<string> =>
  source.includes(from) ? Option.some(source.replace(from, to)) : Option.none()

/** The wrong way: the helper works in the chat's own session. The chat's turn is open, so the helper's is refused. */
export const sameSession = swap(
  `            const session = yield* sessions.create({ owner: "helper", parent: chat.session })`,
  `            // The wrong way: the chat's own session. Its turn is open, so this one is refused.
            const session = chat.session`,
)

/** The helper's calculator takes four seconds: time to send the chat a message while the helper works. */
export const slowHelper = swap(
  `      : Effect.succeed({ "+": a + b, "-": a - b, "*": a * b, "/": a / b }[op]),`,
  `      : Effect.succeed({ "+": a + b, "-": a - b, "*": a * b, "/": a / b }[op]).pipe(Effect.delay("4 seconds")),`,
)

/** The chat's agent gets the helper's tools only: no delegate, so it works everything out in its own session. */
export const noDelegate = swap(`  const toolkit = yield* tools\n`, `  const toolkit = yield* helperTools\n`)
