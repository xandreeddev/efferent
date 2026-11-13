// Lesson 2's chat.ts: lesson 1's chat, with one thing more. A turn that runs
// many steps can take the messages sent while it works (`drain`), so they
// steer it. The page shows this text read-only; program.test.ts compiles and
// runs it.
import { CHAT as LESSON_1_CHAT } from "../your-first-agent/chat.source.ts"

const with_ = (text: string, after: string, added: string): string => {
  if (!text.includes(after)) throw new Error(`lesson 1's chat.ts no longer has: ${after}`)
  return text.replace(after, `${after}${added}`)
}

/** chat.ts, as the learner reads it. */
export const CHAT = with_(
  with_(
    LESSON_1_CHAT,
    "  readonly messages: Stream.Stream<string>\n",
    "  // Every message waiting now, taken at once. A turn that runs many steps takes them between steps.\n  readonly drain: Effect.Effect<ReadonlyArray<string>>\n",
  ),
  "        messages: Stream.fromEffectRepeat(Queue.take(waiting)),\n",
  "        drain: Effect.map(Queue.clear(waiting), (taken) => Array.from(taken)),\n",
)
