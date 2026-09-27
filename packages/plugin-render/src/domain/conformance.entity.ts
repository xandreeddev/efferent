import { Schema } from "effect"

/** A conformance check that did not hold, naming the check. */
export class ConformanceFailure extends Schema.TaggedError<ConformanceFailure>()("ConformanceFailure", {
  check: Schema.String,
  message: Schema.String,
}) {}
