import { Effect, Predicate } from "effect"
import { ConformanceFailure } from "@xandreed/core/kernel"

/*
 * The helpers the loop and memory kits build their checks with: core's
 * kernel keeps its own copy for the storage and sessions kits and exports
 * none, so its API holds no kit-writing helpers.
 */

/** Fail the check `check` with what it found. */
export const fail = (check: string, message: string): Effect.Effect<never, ConformanceFailure> =>
  Effect.fail(new ConformanceFailure({ check, message }))

/** Fail the check `check` unless `holds`. */
export const expect = (check: string, holds: boolean, message: string): Effect.Effect<void, ConformanceFailure> =>
  holds ? Effect.void : fail(check, message)

/** A failure a check did not expect fails the check `check`, with the failure's tag and message. */
export const unexpected = (check: string) => <A, E extends { readonly _tag: string; readonly message: string }, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, ConformanceFailure, R> =>
  Effect.mapError(self, (error) => new ConformanceFailure(
    Predicate.isTagged(error, "ConformanceFailure") && Predicate.hasProperty(error, "check") && Predicate.isString(error.check)
      ? { check: error.check, message: error.message }
      : { check, message: `unexpected ${error._tag}: ${error.message}` },
  ))

/** `call` must fail, with a failure `holds` accepts; `what` says what was called. */
export const refuses = <E extends { readonly _tag: string; readonly message: string }>(check: string, what: string, call: Effect.Effect<unknown, E>, holds: (error: E) => boolean) =>
  Effect.matchEffect(call, {
    onSuccess: () => fail(check, `${what} succeeded`),
    onFailure: (error) => expect(check, holds(error), `${what} failed with ${error._tag}: ${error.message}`),
  })

/** A value as a check words it. */
export const show = (value: unknown): string => JSON.stringify(value)
