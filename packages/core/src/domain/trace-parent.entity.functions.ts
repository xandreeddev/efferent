import { Schema, Tracer } from "effect"
import type { Option } from "effect"
import { TraceParent } from "./trace-parent.entity.js"

const decodeParent = Schema.decodeUnknownOption(TraceParent)

/** Capture valid ancestry as lowercase IDs; invalid or tracing-disabled spans have no durable parent. @public */
export const traceParentOf = (span: Tracer.AnySpan): Option.Option<TraceParent> => decodeParent({
  traceId: span.traceId.toLowerCase(), spanId: span.spanId.toLowerCase(), sampled: span.sampled,
})

/** Restore an immutable parent without capturing a span object or its contextual services. @public */
export const externalSpanOf = (parent: TraceParent): Tracer.ExternalSpan => Tracer.externalSpan(parent)
