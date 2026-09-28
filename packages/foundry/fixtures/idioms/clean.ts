import { Effect, Option } from "effect"

export const longest = (words: ReadonlyArray<string>): Option.Option<string> =>
  Option.fromNullishOr([...words].sort((a, b) => b.length - a.length)[0])

export const total = (words: ReadonlyArray<string>): number =>
  words.reduce((sum, word) => sum + word.length, 0)

/** Effect v4's handler is `Effect.catch` — an Effect export, not Promise#catch. */
export const recovered = Effect.fail("no").pipe(Effect.catch(() => Effect.succeed(0)))
