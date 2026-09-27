import { Schema } from "effect"
import type { Effect } from "effect"

/** A port contract that an implementation broke. */
export class ConformanceFailure extends Schema.TaggedError<ConformanceFailure>()("ConformanceFailure", {
  check: Schema.String,
  message: Schema.String,
}) {}

/** One contract check of a conformance kit, runnable under any test runner. */
export interface ConformanceCheck {
  readonly name: string
  readonly run: Effect.Effect<void, ConformanceFailure>
}
