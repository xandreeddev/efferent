import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema, Tracer } from "effect"
import { externalSpanOf, traceParentOf } from "./trace-parent.entity.functions.js"
import { SpanId, TraceId, TraceParent } from "./trace-parent.entity.js"

const traceId = "1234567890abcdef1234567890abcdef"
const spanId = "1234567890abcdef"
const decode = Schema.decodeUnknownOption(TraceParent)

describe("distributed trace parents", () => {
  test("accepts uppercase IDs and an omitted or false sampling decision", () => {
    const ids = { traceId: traceId.toUpperCase(), spanId: spanId.toUpperCase() }
    const expected = { traceId: TraceId.make(ids.traceId), spanId: SpanId.make(ids.spanId) }
    expect(decode(ids)).toEqual(Option.some(expected))
    expect(decode({ ...ids, sampled: false })).toEqual(Option.some({ ...expected, sampled: false }))
  })

  test.each([
    { traceId: "0".repeat(32), spanId }, { traceId, spanId: "0".repeat(16) },
    { traceId: traceId.slice(1), spanId }, { traceId, spanId: `${spanId}0` },
    { traceId: "g".repeat(32), spanId }, { traceId, spanId: "noop" },
    { traceId: `${traceId}\n`, spanId }, { traceId, spanId: `${spanId}\n` },
  ])("rejects an invalid or zero identity (%j)", (ids) => {
    expect(decode(ids)).toEqual(Option.none())
  })

  test("capture normalizes IDs, keeps false and omits invalid custom spans", () => {
    expect(traceParentOf(Tracer.externalSpan({ traceId: traceId.toUpperCase(), spanId: spanId.toUpperCase(), sampled: false })))
      .toEqual(Option.some({ traceId: TraceId.make(traceId), spanId: SpanId.make(spanId), sampled: false }))
    expect(traceParentOf(Tracer.externalSpan({ traceId: "custom-trace", spanId: "custom-span" }))).toEqual(Option.none())
  })

  test("restores explicit false and the external span constructor's default for absent sampling", () => {
    const ids = { traceId: TraceId.make(traceId), spanId: SpanId.make(spanId) }
    const restored = externalSpanOf({ ...ids, sampled: false })
    expect([restored.traceId, restored.spanId, restored.sampled]).toEqual([traceId, spanId, false])
    expect(externalSpanOf(ids).sampled).toBe(true)
  })

  test("disabled tracing's current noop span is omitted even though the span exists", async () => {
    const capture = Effect.fn("trace_parent.capture")(function* () { return traceParentOf(yield* Effect.currentParentSpan) })
    expect(await Effect.runPromise(capture().pipe(Effect.withTracerEnabled(false)))).toEqual(Option.none())
  })
})
