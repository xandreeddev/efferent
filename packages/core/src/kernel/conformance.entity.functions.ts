import { Effect } from "effect"
import { ConformanceFailure } from "./conformance.entity.js"

/** Fail the check `check` with what it found. */
export const fail = (check: string, message: string): Effect.Effect<never, ConformanceFailure> =>
  Effect.fail(new ConformanceFailure({ check, message }))

/** Fail the check `check` unless `holds`. */
export const expect = (check: string, holds: boolean, message: string): Effect.Effect<void, ConformanceFailure> =>
  holds ? Effect.void : fail(check, message)
