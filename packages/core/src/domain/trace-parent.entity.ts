import { Schema } from "effect"

/** A nonzero 16-byte trace identity, represented as 32 hexadecimal digits. @public */
export const TraceId = Schema.String.check(Schema.isMaxLength(32), Schema.isPattern(/^(?!0{32}$)[0-9a-f]{32}$/i)).pipe(Schema.brand("TraceId"))
export type TraceId = typeof TraceId.Type

/** A nonzero 8-byte span identity, represented as 16 hexadecimal digits. @public */
export const SpanId = Schema.String.check(Schema.isMaxLength(16), Schema.isPattern(/^(?!0{16}$)[0-9a-f]{16}$/i)).pipe(Schema.brand("SpanId"))
export type SpanId = typeof SpanId.Type

/** Serializable distributed ancestry; framework capture always writes the actual sampling decision. @public */
export const TraceParent = Schema.Struct({
  traceId: TraceId,
  spanId: SpanId,
  sampled: Schema.optionalKey(Schema.Boolean),
})
export type TraceParent = typeof TraceParent.Type
