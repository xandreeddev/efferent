// Lesson 18's experiments edit the learner's memory.ts in place, so the code
// and the buttons never disagree. A piece the learner rewrote beyond
// recognition is left alone (None) rather than guessed at.
import { Option } from "effect"
import { WRAPPED } from "./memory.source.ts"

/** Replace one exact piece of code, or None when it is not there. */
const swap = (from: string, to: string) => (source: string): Option.Option<string> =>
  source.includes(from) ? Option.some(source.replace(from, () => to)) : Option.none()

/** memory.ts walking one link at most. */
export const HOPS_ONE = `// The memory a conversation reads with, wrapped: each request is sent the conversation, then up
// to five links near what the question names, one link away at most: the links of a thing the
// question names, and none beyond them.
export const memory = withGraph({
  hops: 1,
  limit: 5,
  speaker: { name: "user", words: ["i", "me", "my"] },
})(flatMemory)`

/** The `hops-one` experiment: a walk of one link. */
export const hopsOne = swap(WRAPPED, HOPS_ONE)

/** memory.ts with a wrapper of the learner's own, over the kernel's parts, that ranks the links by distance alone. */
export const BY_DISTANCE = `// A wrapper of your own, written over the kernel's parts: near is asked with the names the
// question holds, and no other of its words. With no word left to rank by, the links are ranked
// by how many links away they are, then the newest first.
const speaker = { name: "user", words: ["i", "me", "my"] }
const byDistance = (inner) =>
  Layer.effect(
    Memory,
    Effect.gen(function* () {
      const below = yield* Memory // the memory it wraps
      const sessions = yield* Sessions
      return Memory.of({
        context: (session) =>
          Effect.gen(function* () {
            const context = yield* below.context(session)
            // The links that stand, read from the graph session, and the things the question names.
            const links = yield* Effect.provideService(knownLinks, Sessions, sessions)
            const question = questionOf(yield* session.journal)
            const names = namedIn(links, question, Option.some(speaker)).join(" ")
            const chosen = near(links, names, { hops: 2, limit: 5 })
            if (chosen.length === 0) return context
            return [...context, { role: "user", content: linksNote(chosen) }]
          }),
      })
    }),
  ).pipe(Layer.provide(inner))

export const memory = byDistance(flatMemory)`

/** The `by-distance` experiment: the learner's own wrapper in place of the kernel's. */
export const byDistance = swap(WRAPPED, BY_DISTANCE)

/** memory.ts with no wrapper: the kernel's flat memory as it is. */
export const FOLLOW_ONLY = `// No wrapper: each request is sent the conversation alone. The links are still stored, and the
// model is sent none of them unless it calls followThings.
export const memory = flatMemory`

/** The `follow-only` experiment: the wrapper goes. */
export const followOnly = swap(WRAPPED, FOLLOW_ONLY)
