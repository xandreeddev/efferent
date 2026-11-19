import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, ExecutionPlan, Exit, Fiber, Layer, Logger, Option, Predicate, Schedule, Stream, Tracer } from "effect"
import { AiError, LanguageModel, Prompt } from "effect/ai"
import type { Response } from "effect/ai"
import { Core, kernel, Sessions, userMessage } from "@xandreed/core/kernel"
import { inProcessJournal, sessions } from "../../index.js"
import { modelAnswer } from "./model-answer.entity.functions.js"
import { attemptEvent } from "./planned.entity.js"
import { planned, retryable } from "./planned.entity.functions.js"

const usage = { inputTokens: { total: 12, uncached: 12, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } }
const start: Response.StreamPartEncoded = { type: "text-start", id: "t" }
const word = (delta: string): Response.StreamPartEncoded => ({ type: "text-delta", id: "t", delta })
const end: ReadonlyArray<Response.StreamPartEncoded> = [{ type: "text-end", id: "t" }, { type: "finish", reason: "stop", usage }]
const named = (modelId: string): Response.StreamPartEncoded => ({ type: "response-metadata", id: "r", modelId, timestamp: undefined })

/** What one call of a test model does: answer, fail (after what it handed on first), or never finish. */
type Attempt =
  | { readonly answer: string; readonly name?: string }
  | { readonly fails: "retryable" | "final"; readonly after: "nothing" | "start" | "a word" }
  | { readonly hangs: "before anything" | "after a word" }
  | { readonly reports: string; readonly after: "start" | "a word" }

const failure = (model: string, kind: "retryable" | "final") => AiError.make({
  module: model,
  method: "streamText",
  reason: kind === "retryable" ? new AiError.InternalProviderError({ description: "busy" }) : new AiError.UnknownError({ description: "gone" }),
})

/**
 * A model built once, as the page's are, whose `n`th call does the `n`th attempt (the last one again past the end).
 * A failure arrives after the parts before it, on a later step of the scheduler, as a model's own stream fails.
 */
const modelOf = (name: string, attempts: ReadonlyArray<Attempt>) => {
  let calls = 0
  const stream = (attempt: Attempt): Stream.Stream<Response.StreamPartEncoded, AiError.AiError> => {
    if ("answer" in attempt) return Stream.fromIterable([...(attempt.name === undefined ? [] : [named(attempt.name)]), start, word(attempt.answer), ...end])
    if ("reports" in attempt) return Stream.fromIterable([start, ...(attempt.after === "a word" ? [word("Half ")] : []), { type: "error", error: attempt.reports }, ...end])
    if ("hangs" in attempt) return Stream.concat(Stream.fromIterable(attempt.hangs === "after a word" ? [start, word("Half ")] : []), Stream.never)
    const before = attempt.after === "nothing" ? [] : attempt.after === "start" ? [start] : [start, word("Half ")]
    return Stream.concat(Stream.fromIterable(before), Stream.fromEffect(Effect.flatMap(Effect.yieldNow, () => Effect.fail(failure(name, attempt.fails)))))
  }
  const model = Effect.runSync(LanguageModel.make({
    generateText: () => Effect.die("this model only streams"),
    streamText: () => {
      calls++
      return stream(attempts[Math.min(calls, attempts.length) - 1] ?? { fails: "final", after: "nothing" })
    },
  }))
  return { layer: Layer.succeed(LanguageModel.LanguageModel, model), calls: () => calls }
}

const quick = Schedule.spaced("1 millis")
const stack = sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel()))
const ask = Stream.unwrap(Effect.map(LanguageModel.LanguageModel, (model) => model.streamText({ prompt: Prompt.make("hi") })))

/**
 * One turn of a real session: the planned stream read by `modelAnswer`. What comes back: how the call ended, every
 * piece of text the reader was handed, each attempt said about the turn, and what the turn stored.
 */
const turnUnder = <PolicyE>(plan: ExecutionPlan.ExecutionPlan<{ provides: LanguageModel.LanguageModel; input: unknown; error: PolicyE; requirements: never }>, stop?: (pieces: ReadonlyArray<string>) => boolean, readerFails?: string) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const all = yield* Sessions
    const core = yield* Core
    const said: Array<string> = []
    yield* core.on(attemptEvent, (event) => Effect.sync(() => { said.push(`${event.data.outcome} ${event.data.step}.${event.data.attempt}${event.data.reason === undefined ? "" : `: ${event.data.reason}`}`) }), { name: "test", wait: true })
    const id = yield* all.create({ owner: "test" })
    const pieces: Array<string> = []
    const handed = yield* Deferred.make<void>()
    const turn = Effect.scoped(Effect.gen(function* () {
      const session = yield* all.open(id)
      yield* session.append(userMessage("hi"))
      return yield* modelAnswer(planned(plan)(ask), session, {
        onText: (piece) => Effect.flatMap(Effect.sync(() => { pieces.push(piece) }), () => (readerFails !== undefined ? Effect.fail(new Error(readerFails)) : stop?.(pieces) === true ? Deferred.succeed(handed, undefined) : Effect.void)),
      })
    }))
    const fiber = yield* Effect.forkChild(Effect.exit(turn))
    // Stop, as the page's button does, when the test says so: after the reader was handed what it waits for.
    if (stop !== undefined) {
      yield* Effect.raceFirst(Deferred.await(handed), Effect.sleep("200 millis"))
      yield* Fiber.interrupt(fiber)
    }
    const exit = stop === undefined ? yield* Fiber.join(fiber) : Exit.interrupt(0)
    const journal = (yield* all.read(id)).events
    return {
      exit,
      pieces: pieces.join(""),
      said,
      stored: journal.slice(2).map((event) => `${event.name}${event.name === "core.session.turn.ended" ? ` ${JSON.stringify(event.data)}` : ""}`),
      answer: journal.flatMap((event) => (event.message?._tag === "Assistant" ? [event] : [])),
    }
  })).pipe(Effect.provide(stack)))

const failedWith = (exit: Exit.Exit<unknown, unknown>): string => Exit.match(exit, {
  onSuccess: () => "answered",
  onFailure: (cause) => Option.match(Cause.findErrorOption(cause), {
    onNone: () => (Cause.hasInterruptsOnly(cause) ? "interrupted" : "a defect"),
    onSome: (error) => (typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "a failure"),
  }),
})

describe("planned: a model's answer under a plan of Effect's", () => {
  test("a failure worth another try, before anything was handed on, is tried again on the same model, and each attempt is said about the turn", async () => {
    const primary = modelOf("primary", [{ fails: "retryable", after: "start" }, { fails: "retryable", after: "nothing" }, { answer: "Hello." }])
    const ran = await turnUnder(ExecutionPlan.make({ provide: primary.layer, attempts: 3, schedule: quick, while: retryable }))
    expect([failedWith(ran.exit), ran.pieces, primary.calls()]).toEqual(["answered", "Hello.", 3])
    expect(ran.said).toEqual([
      "started 0.1", "failed 0.1: primary.streamText: Internal provider error: busy",
      "started 0.2", "failed 0.2: primary.streamText: Internal provider error: busy",
      "started 0.3", "succeeded 0.3",
    ])
    // Nothing of the attempts is stored: the turn holds the question, the one answer, and its end.
    expect(ran.stored).toEqual(["conversation.assistant.message", 'core.session.turn.ended {"turn":1,"outcome":{"_tag":"Completed"}}'])
  })

  test("a model that started its answer and then failed for good hands the call to the next model: the reader sees only that one's answer", async () => {
    const primary = modelOf("primary", [{ fails: "final", after: "start" }])
    const fallback = modelOf("fallback", [{ answer: "From the fallback." }])
    const ran = await turnUnder(ExecutionPlan.make({ provide: primary.layer, attempts: 3, schedule: quick, while: retryable }, { provide: fallback.layer }))
    expect([failedWith(ran.exit), ran.pieces, primary.calls(), fallback.calls()]).toEqual(["answered", "From the fallback.", 1, 1])
    expect(ran.said).toEqual(["started 0.1", "failed 0.1: primary.streamText: gone", "started 1.2", "succeeded 1.2"])
  })

  test("a failure after a word was handed on is final: the word is seen once, the call fails with AnswerCut, and neither the model nor the next one is asked again, with or without a `while`", async () => {
    for (const withWhile of [true, false]) {
      const primary = modelOf("primary", [{ fails: "retryable", after: "a word" }])
      const fallback = modelOf("fallback", [{ answer: "From the fallback." }])
      const first = withWhile ? { provide: primary.layer, attempts: 3, schedule: quick, while: retryable } : { provide: primary.layer, attempts: 3, schedule: quick }
      const ran = await turnUnder(ExecutionPlan.make(first, { provide: fallback.layer }))
      expect({ withWhile, ended: failedWith(ran.exit), pieces: ran.pieces, primary: primary.calls(), fallback: fallback.calls() })
        .toEqual({ withWhile, ended: "AnswerCut", pieces: "Half ", primary: 1, fallback: 0 })
      // modelAnswer stores nothing of a call that failed: the turn holds no answer.
      expect(ran.answer).toEqual([])
    }
  })

  test("an answer that hands on no content still hands on what it held: its end and its usage, stored with the answer", async () => {
    const quiet = Effect.runSync(LanguageModel.make({
      generateText: () => Effect.die("this model only streams"),
      streamText: () => Stream.fromIterable<Response.StreamPartEncoded>([named("quiet-1"), start, ...end]),
    }))
    const ran = await turnUnder(ExecutionPlan.make({ provide: Layer.succeed(LanguageModel.LanguageModel, quiet) }))
    expect(failedWith(ran.exit)).toBe("answered")
    expect(ran.answer.map((event) => event.data)).toEqual([{ model: "quiet-1", usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 0 } }])
  })

  test("the model that answered is named by the answer's record: the fallback's name, never the name a failed attempt gave", async () => {
    const primary = modelOf("primary", [{ fails: "final", after: "start" }])
    const namesItself = Effect.runSync(LanguageModel.make({
      generateText: () => Effect.die("this model only streams"),
      streamText: () => Stream.concat(Stream.succeed(named("primary-1")), Stream.fail(failure("primary", "final"))),
    }))
    const fallback = modelOf("fallback", [{ answer: "Hi.", name: "fallback-1" }])
    const ran = await turnUnder(ExecutionPlan.make({ provide: Layer.succeed(LanguageModel.LanguageModel, namesItself) }, { provide: fallback.layer }))
    expect(failedWith(ran.exit)).toBe("answered")
    expect(ran.answer.map((event) => event.data)).toEqual([{ model: "fallback-1", usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 0 } }])
    void primary
  })

  test("a model that reports an error inside its stream before any content has failed that attempt: a failure `retryable` refuses, so the call is handed to the next model", async () => {
    const primary = modelOf("primary", [{ reports: "overloaded", after: "start" }, { answer: "Hello." }])
    const fallback = modelOf("fallback", [{ answer: "From the fallback." }])
    const ran = await turnUnder(ExecutionPlan.make({ provide: primary.layer, attempts: 3, schedule: quick, while: retryable }, { provide: fallback.layer }))
    expect([failedWith(ran.exit), ran.pieces, primary.calls(), fallback.calls()]).toEqual(["answered", "From the fallback.", 1, 1])
    expect(ran.said).toEqual(["started 0.1", "failed 0.1: overloaded", "started 1.2", "succeeded 1.2"])
  })

  test("an error reported after a word cuts the answer as a failed stream does: AnswerCut, and no model is asked again", async () => {
    const primary = modelOf("primary", [{ reports: "overloaded", after: "a word" }, { answer: "Hello." }])
    const fallback = modelOf("fallback", [{ answer: "From the fallback." }])
    const ran = await turnUnder(ExecutionPlan.make({ provide: primary.layer, attempts: 3, schedule: quick }, { provide: fallback.layer }))
    expect([failedWith(ran.exit), ran.pieces, primary.calls(), fallback.calls()]).toEqual(["AnswerCut", "Half ", 1, 0])
  })

  test("a reader that fails ends the call: the attempt is said to have failed in the reader's words, and no model is asked again", async () => {
    const primary = modelOf("primary", [{ answer: "Hello." }])
    const fallback = modelOf("fallback", [{ answer: "From the fallback." }])
    const ran = await turnUnder(ExecutionPlan.make({ provide: primary.layer, attempts: 3, schedule: quick }, { provide: fallback.layer }), undefined, "the chat is gone")
    expect([failedWith(ran.exit), primary.calls(), fallback.calls()]).toEqual(["a failure", 1, 0])
    expect(ran.said).toEqual(["started 0.1", "failed 0.1: the chat is gone"])
  })

  test("an attempt that cannot be said does not fail the call: a waiting listener fails the publish, planned logs it as a warning, and the answer stands", async () => {
    const primary = modelOf("primary", [{ fails: "retryable", after: "nothing" }, { answer: "Hello." }])
    const plan = ExecutionPlan.make({ provide: primary.layer, attempts: 2, schedule: quick, while: retryable })
    const warnings: Array<string> = []
    const logger = Logger.make((options) => {
      const words = [options.message].flat().filter(Predicate.isString).join(" ")
      if (options.logLevel === "Warn") warnings.push(words)
    })
    let heard = 0
    const exit = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const all = yield* Sessions
      yield* (yield* Core).on(attemptEvent, () => Effect.flatMap(Effect.sync(() => { heard++ }), () => Effect.fail("the listener broke")), { name: "broken", wait: true })
      const id = yield* all.create({ owner: "test" })
      const session = yield* all.open(id)
      yield* session.append(userMessage("hi"))
      return yield* Effect.exit(modelAnswer(planned(plan)(ask), session))
    })).pipe(Effect.provide(Layer.merge(stack, Logger.layer([logger])))))
    expect(failedWith(exit)).toBe("answered")
    expect(primary.calls()).toBe(2)
    // Four attempts' events (two starts, a failure, a success), each heard, each failing its publish, each logged.
    expect(heard).toBe(4)
    expect(warnings).toEqual(Array.from({ length: 4 }, () => "a model attempt could not be said"))
  })

  test("Stop after a word ends the turn as interrupted, not as a cut answer; Stop while a model has said nothing does too", async () => {
    const talking = await turnUnder(ExecutionPlan.make({ provide: modelOf("primary", [{ hangs: "after a word" }]).layer }), (pieces) => pieces.length > 0)
    expect([talking.pieces, talking.stored]).toEqual(["Half ", ['core.session.turn.ended {"turn":1,"outcome":{"_tag":"Interrupted"}}']])
    expect(talking.said).toEqual(["started 0.1", "failed 0.1: stopped"].slice(0, talking.said.length))
    const silent = await turnUnder(ExecutionPlan.make({ provide: modelOf("primary", [{ hangs: "before anything" }]).layer }), () => true)
    expect([silent.pieces, silent.stored]).toEqual(["", ['core.session.turn.ended {"turn":1,"outcome":{"_tag":"Interrupted"}}']])
  })

  test("Stop during the wait between attempts ends the turn at once, as interrupted", async () => {
    const primary = modelOf("primary", [{ fails: "retryable", after: "nothing" }])
    const started = performance.now()
    const ran = await turnUnder(ExecutionPlan.make({ provide: primary.layer, attempts: 3, schedule: Schedule.spaced("30 seconds"), while: retryable }), () => false)
    expect(performance.now() - started).toBeLessThan(2_000)
    expect([primary.calls(), ran.stored]).toEqual([1, ['core.session.turn.ended {"turn":1,"outcome":{"_tag":"Interrupted"}}']])
  })

  test("retryable: a rate limit, a provider's own error and a lost connection are worth another try; a refused request, an unknown error and anything that is no AiError are not", () => {
    const of = (reason: AiError.AiErrorReason) => AiError.make({ module: "m", method: "streamText", reason })
    expect([
      retryable(of(new AiError.RateLimitError({}))),
      retryable(of(new AiError.InternalProviderError({ description: "x" }))),
      retryable(of(new AiError.InvalidRequestError({ description: "x" }))),
      retryable(of(new AiError.UnknownError({ description: "x" }))),
      retryable(new Error("x")),
      retryable("x"),
    ]).toEqual([true, true, false, false, false, false])
  })
})

/*
 * What the guard leans on, in Effect 4.0.7's ExecutionPlan (marked unstable): pinned here, so an upgrade that
 * changes either fails loudly.
 */
describe("the two behaviours of Effect's plan that planned relies on", () => {
  const read = (stream: Stream.Stream<Response.AnyPart, unknown>) => Effect.runPromise(Effect.exit(Stream.runCollect(stream)))

  test("a plan does not retry or fall back from a defect", async () => {
    let calls = 0
    const dies = Effect.runSync(LanguageModel.make({ generateText: () => Effect.die("no"), streamText: () => { calls++; return Stream.die("broken") } }))
    const fallback = modelOf("fallback", [{ answer: "x" }])
    const plan = ExecutionPlan.make({ provide: Layer.succeed(LanguageModel.LanguageModel, dies), attempts: 3, schedule: quick }, { provide: fallback.layer })
    const exit = await read(ask.pipe(Stream.withExecutionPlan(plan)))
    expect([Exit.isFailure(exit), calls, fallback.calls()]).toEqual([true, 1, 0])
  })

  test("why planned does not use Effect's preventFallbackOnPartialStream (the rejected alternative, ADR 0015): it counts a start part as output, so a model that started and failed for good would not be handed on", async () => {
    const primary = modelOf("primary", [{ fails: "final", after: "start" }])
    const fallback = modelOf("fallback", [{ answer: "x" }])
    const plan = ExecutionPlan.make({ provide: primary.layer }, { provide: fallback.layer })
    const exit = await read(ask.pipe(Stream.withExecutionPlan(plan, { preventFallbackOnPartialStream: true })))
    expect([Exit.isFailure(exit), fallback.calls()]).toEqual([true, 0])
  })

  test("a step without a `while` tries a failure after a word again, and the reader sees the word again: what planned prevents", async () => {
    const primary = modelOf("primary", [{ fails: "retryable", after: "a word" }])
    const seen: Array<string> = []
    const plan = ExecutionPlan.make({ provide: primary.layer, attempts: 3, schedule: quick })
    await read(ask.pipe(Stream.withExecutionPlan(plan, { preventFallbackOnPartialStream: true }), Stream.tap((part) => Effect.sync(() => { if (part.type === "text-delta") seen.push(part.delta) }))))
    expect(seen.join("")).toBe("Half Half Half ")
  })
})

describe("planned: what a tracer sees", () => {
  test("each attempt is the model's own span, and the plan marks each on the span current where it runs (kernel.model.attempt)", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({ span: (options) => {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    } })
    const primary = modelOf("primary", [{ fails: "retryable", after: "nothing" }, { answer: "Hello." }])
    await Effect.runPromise(Stream.runCollect(planned(ExecutionPlan.make({ provide: primary.layer, attempts: 2, schedule: quick, while: retryable }))(ask)).pipe(
      Effect.withSpan("host.step"),
      Effect.withTracer(tracer),
    ))
    const step = spans.find((span) => span.name === "host.step")
    expect(spans.filter((span) => span.name === "LanguageModel.streamText").map((span) => Option.map(span.parent, (parent) => parent.spanId))).toEqual([Option.some(step!.spanId), Option.some(step!.spanId)])
    expect(step!.events.map(([name, , attributes]) => [name, attributes])).toEqual([
      ["kernel.model.attempt", { "efferent.attempt": 1, "efferent.plan.step": 0, "efferent.outcome": "started" }],
      ["kernel.model.attempt", { "efferent.attempt": 1, "efferent.plan.step": 0, "efferent.outcome": "failed", "efferent.reason": "primary.streamText: Internal provider error: busy" }],
      ["kernel.model.attempt", { "efferent.attempt": 2, "efferent.plan.step": 0, "efferent.outcome": "started" }],
      ["kernel.model.attempt", { "efferent.attempt": 2, "efferent.plan.step": 0, "efferent.outcome": "succeeded" }],
    ])
  })
})
