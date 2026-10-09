import { Schema } from "effect"
import { Version } from "./identity.entity.js"

export const ContextBudget = Schema.Struct({
  maxBytes: Schema.Int.check(Schema.isGreaterThan(0)),
  reservedBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type ContextBudget = typeof ContextBudget.Type
export const GradingContext = Schema.Struct({
  projection: Schema.NonEmptyString, version: Version, input: Schema.Unknown,
  references: Schema.Array(Schema.String), omissions: Schema.Array(Schema.String),
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), fingerprint: Schema.NonEmptyString,
})
export type GradingContext = typeof GradingContext.Type
