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

/**
 * The loop protection a host may set in `LoopLimits`, each field optional:
 * `Agent.define` decodes its `limits` with this (`config.limits`) and a run
 * decodes the turn's merged limits (`turn.limits`), so a bad policy fails
 * before any step rather than inside the loop. @public
 */
export const LoopProtection = Schema.Struct({
  degenerate: Schema.optionalKey(DegeneratePolicy),
  malformedLimit: Schema.optionalKey(MalformedLimit),
})
export type LoopProtection = typeof LoopProtection.Type
