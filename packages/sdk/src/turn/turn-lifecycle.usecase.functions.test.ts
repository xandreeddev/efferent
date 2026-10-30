import { describe, expect, test } from "bun:test"
import { Effect, Logger, Option, References, Tracer } from "effect"
import { ConversationId, HarnessError, RunId, SessionBusy, tokenUsage, UserMessage, zeroUsage } from "@xandreed/core"
import type { JsonObject, TurnResult, TurnWriter } from "@xandreed/core"
import { traceTurn, traceTurnBegin } from "./turn-lifecycle.usecase.functions.js"

const session = ConversationId.make("00000000-0000-4000-8000-0000000000c1")

/** A writer of turn 3 of `session`: `traceTurn` reads only what was admitted. */
const writerWith = (meta: JsonObject, resumes?: number): TurnWriter => ({
  admitted: {
    session: { id: session, owner: "test" }, turn: 3, runId: RunId.make("run-3"), key: "run-3", origin: "inbox",
    userMessage: new UserMessage({ text: "hello" }), command: {}, claimed: [], meta,
    ...(resumes === undefined ? {} : { resumes }),
  },
  started: { session, seq: 1, turn: Option.some(3), kind: "turn.started", at: 0, data: {} },
  history: () => Effect.die("unused"),
  snapshot: () => Effect.die("unused"),
  append: () => Effect.die("unused"),
  write: () => Effect.die("unused"),
  transact: () => Effect.die("unused"),
  flush: Effect.void,
  closing: () => Effect.die("unused"),
  end: () => Effect.die("unused"),
  closed: Effect.never,
})

/** Run `body` as a traced turn under a tracer that keeps every span. */
const traced = (body: Effect.Effect<TurnResult, HarnessError>, meta: JsonObject = {}, spanMeta?: ReadonlyArray<string>, resumes?: number) => Effect.gen(function* () {
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    },
  })
  const exit = yield* body.pipe(traceTurn(writerWith(meta, resumes), spanMeta === undefined ? {} : { spanMeta }), Effect.withTracer(tracer), Effect.exit)
  return { exit, spans }
})

const read = (span: Tracer.NativeSpan | undefined, keys: ReadonlyArray<string>) => keys.map((key) => span?.attributes.get(key))
const ids = ["efferent.session.id", "efferent.run.id", "efferent.turn"]

describe("traceTurn", () => {
  test("opens agent.turn with the turn's ids, conversation and origin; every span under it carries the ids", async () => {
    const { spans } = await Effect.runPromise(traced(Effect.succeed<TurnResult>({ outcome: "completed", reply: Option.some("hi"), usage: zeroUsage }).pipe(
      Effect.tap(() => Effect.void.pipe(Effect.withSpan("child"), Effect.withSpan("grandchild"))),
    )))
    const turn = spans.find((span) => span.name === "agent.turn")
    expect(read(turn, [...ids, "gen_ai.conversation.id", "efferent.origin"])).toEqual([session, "run-3", 3, session, "inbox"])
    expect(Option.isNone(turn?.parent ?? Option.none())).toBe(true)
    expect(turn?.attributes.has("efferent.resumes")).toBe(false)
    expect(spans.filter((span) => span.name !== "agent.turn").map((span) => read(span, ids))).toEqual([[session, "run-3", 3], [session, "run-3", 3]])
  })

  test("a turn that resumes another names it in efferent.resumes", async () => {
    const { spans } = await Effect.runPromise(traced(Effect.succeed<TurnResult>({ outcome: "completed", reply: Option.none(), usage: zeroUsage }), {}, undefined, 2))
    expect(spans.find((span) => span.name === "agent.turn")?.attributes.get("efferent.resumes")).toBe(2)
  })

  test("ends with the outcome and the turn's usage when the turn returns", async () => {
    const usage = tokenUsage({ inputTokens: 120, outputTokens: 30, cacheReadTokens: 40, cacheWriteTokens: 10, reasoningTokens: 5 })
    const { spans } = await Effect.runPromise(traced(Effect.succeed<TurnResult>({ outcome: "partial", reply: Option.none(), usage })))
    const turn = spans.find((span) => span.name === "agent.turn")
    expect(read(turn, [
      "efferent.outcome", "efferent.usage.input_tokens", "efferent.usage.output_tokens", "efferent.usage.cache_read_tokens",
      "efferent.usage.cache_write_tokens", "efferent.usage.reasoning_tokens", "efferent.usage.total_tokens",
    ])).toEqual(["partial", 120, 30, 40, 10, 5, 150])
    expect(turn?.attributes.has("efferent.failure.code")).toBe(false)
  })

  test("ends with the failure's code when the turn fails, and as interrupted when it is interrupted", async () => {
    const failed = await Effect.runPromise(traced(Effect.fail(new HarnessError({ code: "host.failed", message: "the host gave up" }))))
    const failedTurn = failed.spans.find((span) => span.name === "agent.turn")
    expect(failed.exit._tag).toBe("Failure")
    expect(read(failedTurn, ["efferent.outcome", "efferent.failure.code"])).toEqual(["failed", "host.failed"])
    expect(failedTurn?.attributes.has("efferent.usage.input_tokens")).toBe(false)
    expect(failedTurn?.status._tag === "Ended" && failedTurn.status.exit._tag).toBe("Failure")
    const interrupted = await Effect.runPromise(traced(Effect.interrupt))
    expect(read(interrupted.spans.find((span) => span.name === "agent.turn"), ["efferent.outcome", "efferent.failure.code"])).toEqual(["interrupted", "turn.interrupted"])
  })

  test("carries only the allowed metadata keys, a value that is not a string, number or boolean as JSON", async () => {
    const meta: JsonObject = { requestId: "req-7", attempt: 2, beta: true, client: { name: "web" }, user: "u-1" }
    const result = Effect.succeed<TurnResult>({ outcome: "completed", reply: Option.none(), usage: zeroUsage })
    const allowed = await Effect.runPromise(traced(result, meta, ["requestId", "attempt", "beta", "client", "absent"]))
    const turn = allowed.spans.find((span) => span.name === "agent.turn")
    expect([...(turn?.attributes.keys() ?? [])].filter((key) => key.startsWith("efferent.meta.")).sort()).toEqual([
      "efferent.meta.attempt", "efferent.meta.beta", "efferent.meta.client", "efferent.meta.requestId",
    ])
    expect(read(turn, ["efferent.meta.requestId", "efferent.meta.attempt", "efferent.meta.beta", "efferent.meta.client"])).toEqual(["req-7", 2, true, "{\"name\":\"web\"}"])
    const none = await Effect.runPromise(traced(result, meta))
    expect([...(none.spans.find((span) => span.name === "agent.turn")?.attributes.keys() ?? [])].some((key) => key.startsWith("efferent.meta."))).toBe(false)
  })
})

describe("traceTurnBegin", () => {
  const begin = { session, runId: RunId.make("run-3"), origin: "user" } as const
  const keeping = (spans: Array<Tracer.NativeSpan>) => Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    },
  })
  const parentOf = (spans: ReadonlyArray<Tracer.NativeSpan>, span: Tracer.NativeSpan | undefined) =>
    Option.map(Option.flatMap(Option.fromNullishOr(span), (child) => child.parent), (parent) => spans.find((candidate) => candidate.spanId === parent.spanId)?.name)

  test("opens agent.turn.begin beside agent.turn under the caller's span, with the begin's ids and origin, and ends with the turn it began", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    await Effect.runPromise(Effect.gen(function* () {
      const writer = yield* Effect.succeed(writerWith({})).pipe(Effect.tap(() => Effect.void.pipe(Effect.withSpan("store.begin"))), traceTurnBegin(begin))
      return yield* Effect.succeed<TurnResult>({ outcome: "completed", reply: Option.none(), usage: zeroUsage }).pipe(traceTurn(writer))
    }).pipe(Effect.withSpan("caller"), Effect.withTracer(keeping(spans))))
    const begun = spans.find((span) => span.name === "agent.turn.begin")
    expect(["agent.turn.begin", "agent.turn", "store.begin"].map((name) => parentOf(spans, spans.find((span) => span.name === name))))
      .toEqual([Option.some("caller"), Option.some("caller"), Option.some("agent.turn.begin")])
    expect(read(begun, [...ids, "efferent.origin"])).toEqual([session, "run-3", 3, "user"])
    expect(begun?.attributes.has("efferent.failure.code")).toBe(false)
    expect(begun?.status._tag === "Ended" && begun.status.exit._tag).toBe("Success")
  })

  test("a begin that fails ends with the refusal's code, as agent.turn gives it, and names no turn", async () => {
    const codeOf = (effect: Effect.Effect<TurnWriter, unknown>) => Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = []
      yield* effect.pipe(traceTurnBegin(begin), Effect.withTracer(keeping(spans)), Effect.exit)
      const begun = spans.find((span) => span.name === "agent.turn.begin")
      return read(begun, ["efferent.failure.code", "efferent.turn", "efferent.session.id"])
    })
    const codes = await Effect.runPromise(Effect.all([
      codeOf(Effect.fail(new SessionBusy({ session, turn: 2 }))),
      codeOf(Effect.fail(new HarnessError({ code: "host.refused", message: "the host would not begin it" }))),
      codeOf(Effect.die("the store broke")),
      codeOf(Effect.interrupt),
    ], { concurrency: 1 }))
    expect(codes).toEqual([
      ["session.busy", undefined, session],
      ["host.refused", undefined, session],
      ["turn.defect", undefined, session],
      ["turn.interrupted", undefined, session],
    ])
  })

  test("the begin's logs carry the session and run ids as annotations", async () => {
    const annotations: Array<Readonly<Record<string, unknown>>> = []
    const logger = Logger.make((options) => {
      annotations.push(options.fiber.getRef(References.CurrentLogAnnotations))
    })
    await Effect.runPromise(Effect.logInfo("beginning").pipe(Effect.as(writerWith({})), traceTurnBegin(begin), Effect.provide(Logger.layer([logger]))))
    expect(annotations).toEqual([{ "efferent.session.id": session, "efferent.run.id": "run-3" }])
  })
})
