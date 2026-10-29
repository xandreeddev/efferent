import { describe, expect, test } from "bun:test"
import { Context, Effect, Logger, Option, References, Tracer } from "effect"
import { SessionEnvironment } from "../ports/harness.port.js"
import { CurrentTraceContent, replayableContext } from "./traceContent.js"

describe("replayableContext", () => {
  test("keeps the services and drops the trace and log state of where it was captured", async () => {
    const captured = await Effect.runPromise(Effect.context<SessionEnvironment>().pipe(
      Effect.provideService(CurrentTraceContent, true),
      Effect.annotateSpans({ "captured.here": true }),
      Effect.annotateLogs({ "captured.here": true }),
      Effect.withLogSpan("captured.log"),
      Effect.linkSpans(Tracer.externalSpan({ traceId: "t".repeat(32), spanId: "s".repeat(16) })),
      Effect.withSpan("captured"),
      Effect.provideService(SessionEnvironment, { workspace: "kept" }),
    ))
    const replayable = replayableContext(captured)
    expect(Context.get(replayable, SessionEnvironment).workspace).toBe("kept")
    const dropped = [
      Tracer.ParentSpan, References.TracerSpanAnnotations, References.TracerSpanLinks,
      References.CurrentLogAnnotations, References.CurrentLogSpans, References.CurrentStackFrame, CurrentTraceContent,
    ]
    expect(dropped.map((tag) => [captured.mapUnsafe.has(tag.key), replayable.mapUnsafe.has(tag.key)])).toEqual(dropped.map(() => [true, false]))
  })

  test("work it runs logs with the annotations of where it runs, not of where it was captured", async () => {
    const annotations: Array<Readonly<Record<string, unknown>>> = []
    const logger = Logger.make((options) => {
      annotations.push(options.fiber.getRef(References.CurrentLogAnnotations))
    })
    await Effect.runPromise(Effect.gen(function* () {
      const captured = yield* Effect.context<never>().pipe(Effect.annotateLogs({ "captured.here": true, "efferent.turn": 0 }))
      yield* Effect.logInfo("replayed").pipe(
        Effect.provide(replayableContext(captured)),
        Effect.annotateLogs({ "efferent.turn": 1 }),
      )
    }).pipe(Effect.provide(Logger.layer([logger]))))
    expect(annotations).toEqual([{ "efferent.turn": 1 }])
  })

  test("work it runs is traced where it runs: under that span, with its annotations, links and trace content", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      },
    })
    const read = await Effect.runPromise(Effect.gen(function* () {
      const captured = yield* Effect.context<never>().pipe(
        Effect.provideService(CurrentTraceContent, true),
        Effect.annotateSpans({ "captured.here": true }),
        Effect.withSpan("captured"),
      )
      return yield* Effect.service(CurrentTraceContent).pipe(
        Effect.withSpan("work"),
        Effect.provide(replayableContext(captured)),
        Effect.annotateSpans({ "efferent.turn": 1 }),
        Effect.withSpan("runs.here"),
      )
    }).pipe(Effect.withTracer(tracer)))
    expect(read).toBe(false)
    const work = spans.find((span) => span.name === "work")
    const parent = Option.flatMap(Option.fromNullishOr(work), (span) => span.parent)
    expect(Option.map(parent, (span) => span.spanId)).toEqual(Option.fromNullishOr(spans.find((span) => span.name === "runs.here")?.spanId))
    expect(["efferent.turn", "captured.here"].map((key) => work?.attributes.get(key))).toEqual([1, undefined])
  })
})
