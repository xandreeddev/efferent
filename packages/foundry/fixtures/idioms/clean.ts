import { Option } from "effect"

export const longest = (words: ReadonlyArray<string>): Option.Option<string> =>
  Option.fromNullable([...words].sort((a, b) => b.length - a.length)[0])

export const total = (words: ReadonlyArray<string>): number =>
  words.reduce((sum, word) => sum + word.length, 0)
