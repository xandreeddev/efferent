import { Option } from "effect"

/** Flag parsing shared by eval command lines; `argv` defaults to the process arguments. */
export const argValue = (name: string, argv: ReadonlyArray<string> = process.argv): Option.Option<string> => {
  const at = argv.indexOf(name)
  return Option.fromNullishOr(at < 0 ? undefined : argv[at + 1])
}

export const hasFlag = (name: string, argv: ReadonlyArray<string> = process.argv): boolean => argv.includes(name)

export const csv = (name: string, fallback: ReadonlyArray<string>, argv: ReadonlyArray<string> = process.argv): ReadonlyArray<string> =>
  Option.match(argValue(name, argv), {
    onNone: () => fallback,
    onSome: (value) => value.split(",").map((entry) => entry.trim()).filter(Boolean),
  })

export const positiveInt = (name: string, fallback: number, argv: ReadonlyArray<string> = process.argv): number =>
  Option.match(argValue(name, argv), {
    onNone: () => fallback,
    onSome: (value) => {
      const parsed = Math.floor(Number(value))
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
    },
  })
