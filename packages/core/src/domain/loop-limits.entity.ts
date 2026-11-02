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
 * What the loop does with a whole reply's tool call it will not run, one
 * that names a tool the step does not have or gives parameters its schema
 * does not decode: `corrective` (the default) runs none of the reply's
 * calls and answers the reply with a corrective turn, as malformed;
 * `answer` answers each such call with a failure result and runs the
 * reply's other calls. A reply that repeats a call id is malformed under
 * both. @public
 */
export const InvalidCallPolicy = Schema.Literals(["corrective", "answer"])
export type InvalidCallPolicy = typeof InvalidCallPolicy.Type

/**
 * The loop protection a host may set in `LoopLimits`, each field optional:
 * `Agent.define` decodes its `limits` with this (`config.limits`) and a run
 * decodes the turn's merged limits (`turn.limits`), so a bad policy fails
 * before any step rather than inside the loop. @public
 */
export const LoopProtection = Schema.Struct({
  degenerate: Schema.optionalKey(DegeneratePolicy),
  malformedLimit: Schema.optionalKey(MalformedLimit),
  invalidCalls: Schema.optionalKey(InvalidCallPolicy),
})
export type LoopProtection = typeof LoopProtection.Type
