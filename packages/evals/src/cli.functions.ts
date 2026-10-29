import { Effect, Option, Schema } from "effect"
import { EvaluationError } from "./domain/identity.entity.js"

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

const PositiveInt = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0))

/**
 * A positive whole-number flag: `fallback` when the flag is absent, and a
 * usage error (`invalid`) when it is given without a positive integer, never
 * a silent fallback.
 */
export const positiveInt = (name: string, fallback: number, argv: ReadonlyArray<string> = process.argv): Effect.Effect<number, EvaluationError> =>
  Option.match(argValue(name, argv), {
    onNone: () => hasFlag(name, argv)
      ? Effect.fail(new EvaluationError({ code: "invalid", message: `${name} needs a positive integer` }))
      : Effect.succeed(fallback),
    onSome: (value) => Schema.decodeUnknownEffect(PositiveInt)(value).pipe(
      Effect.mapError(() => new EvaluationError({ code: "invalid", message: `${name} needs a positive integer, not ${JSON.stringify(value)}` })),
    ),
  })
