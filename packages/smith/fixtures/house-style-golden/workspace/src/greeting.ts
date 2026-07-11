import { Option } from "effect"

export const greet = (name: Option.Option<string>): string =>
  Option.match(name, {
    onNone: () => "hello, world",
    onSome: (person) => `hello, ${person}`,
  })
