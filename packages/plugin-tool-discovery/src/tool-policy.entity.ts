import { Schema } from "effect"

/** Host limits for one registered tool. Omitted limits are disabled. @public */
export const ToolPolicy = Schema.Struct({
  concurrency: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1024 }))),
  maxCallsPerRun: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000000 }))),
  breakAfter: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000000 }))),
  breakOn: Schema.optionalKey(Schema.Literals(["defects", "failures"])),
})
export type ToolPolicy = typeof ToolPolicy.Type

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const ToolBreaker = Schema.Union([
  Schema.TaggedStruct("Closed", { failures: Count }),
  Schema.TaggedStruct("Tripped", { failures: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) }),
])
export type ToolBreaker = typeof ToolBreaker.Type

export const ToolAdmission = Schema.Struct({
  turn: Schema.Record(Schema.String, Count),
  runs: Schema.Record(Schema.String, Schema.Struct({
    calls: Schema.Record(Schema.String, Count),
    breakers: Schema.Record(Schema.String, ToolBreaker),
  })),
})
export type ToolAdmission = typeof ToolAdmission.Type
