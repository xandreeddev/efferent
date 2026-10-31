import { Schema } from "effect"

/** Repeated-result protection; successful new progress resets its stale count. @public */
export const DegeneratePolicy = Schema.Union([
  Schema.TaggedStruct("Disabled", {}),
  Schema.TaggedStruct("Enabled", {
    nudgeAfter: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000000 })),
    breakAfter: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 1000000 })),
  }).check(Schema.makeFilter((value) => value.nudgeAfter < value.breakAfter || "nudgeAfter must precede breakAfter")),
])
export type DegeneratePolicy = typeof DegeneratePolicy.Type

/** Failure occurs on this consecutive malformed response, not after this many retries. @public */
export const MalformedLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))
