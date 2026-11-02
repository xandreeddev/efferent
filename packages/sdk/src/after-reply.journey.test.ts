import { expect, test } from "bun:test"
import { LanguageModel } from "effect/ai"
import { Context, Deferred, Effect, Fiber, Layer, Option, Ref, Schema, Stream } from "effect"
import {
  ConversationId, ConversationMemory, CurrentAgentRun, definePlugin, ENGINE_KEY, HarnessError, ModelCallId, ModelId, ModelSelection,
  openLogSession, ProviderId, recordCompletion, RunId, SessionLogMemoryLive, Sessions, tokenUsage, TurnAdmissionOpen,
  turnEndedOf, turnModelCallsOf, TurnShutdown, UserMessage,
} from "@xandreed/core"
import type { MaintainSignal, MemoryPolicy, SessionAddress, SessionLogEvent } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { Agent } from "./agent.adapter.js"

/*
 * Key-free journeys of the work a turn does after its reply (its memory
 * maintenance): it runs after the reply is final and sealed, inside the
 * turn, billed by the turn's recorder and calibrated by the run's reported
 * input; nothing it meets (an interruption, a failure, a time limit, a
 * shutdown) can cost the reply or leave the turn to be asked again.
 */

const helper = new ModelSelection({ provider: ProviderId.make("fixture"), modelId: ModelId.make("helper") })
type Mode = "record" | "hang" | "fail"

const fixture = (mode: Mode, sessionNumber: number, timeLimitMs?: number) => Effect.gen(function* () {
  const entered = yield* Deferred.make<void>()
  const signals = yield* Ref.make<ReadonlyArray<MaintainSignal>>([])
  const policy: MemoryPolicy = {
    strategy: { id: "after-reply", version: "1" },
    render: { turnContext: "current", replies: true, digests: true, media: { mode: "none", maxImages: 0, maxChars: 0 } },
    digestOnWrite: Option.none(),
    maintain: ({ signal }) => Effect.gen(function* () {
      yield* Ref.update(signals, (all) => [...all, signal])
      if (signal.phase !== "turn-end") return { actions: [], digest: [] }
      const run = yield* CurrentAgentRun
      // The helper is billed by the turn that bought it, before anything else happens.
      yield* recordCompletion({
        callId: ModelCallId.make(`summary:${Option.match(run, { onNone: () => "none", onSome: (value) => value.turn })}`), attempt: 1, purpose: "Helper", method: "Text", model: Option.some(helper),
        runId: Option.map(run, (value) => value.id), run: Option.map(run, (value) => value.ordinal), step: Option.none(), durationMs: 1,
        usage: { _tag: "Known", usage: tokenUsage({ inputTokens: 5, outputTokens: 1 }) }, outcome: { _tag: "Completed" },
      }).pipe(Effect.orDie)
      // Only the first turn's work hangs: a later turn's is left to finish.
      const first = yield* Deferred.succeed(entered, undefined)
      if (mode === "hang" && first) return yield* Effect.never
      if (mode === "fail") return yield* Effect.fail(new HarnessError({ code: "memory.summary", message: "the post-reply fixture failed" }))
      return { actions: [], digest: [] }
    }),
  }
  const memory = definePlugin({
    id: "fixture/after-reply-memory", version: "1", scope: "runtime", config: Schema.Struct({}), defaults: {}, provides: [ConversationMemory],
    layer: () => Layer.succeed(ConversationMemory, { strategy: policy.strategy, open: (input) => openLogSession(input.log, policy, { runId: input.runId }) }),
  })
  // One store; a second instance over it stands for the next process.
  const store = yield* Layer.build(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen))
  const instance = Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.succeedContext(store))))
  const built = yield* instance
  const sessions = Context.get(built, Sessions)
  const shutdown = Context.get(built, TurnShutdown)
  const session: SessionAddress = { owner: "fixture", id: ConversationId.make(`00000000-0000-4000-8000-${String(sessionNumber).padStart(12, "0")}`) }
  yield* sessions.create(session)
  const agent = yield* Agent.define({ plugins: [memory, toolDiscoveryPlugin, stepLoopPlugin], turnServices: [LanguageModel.LanguageModel, Sessions], limits: { streaming: false, maxSteps: 1 } })
  const calls = yield* Ref.make(0)
  const model = yield* LanguageModel.make({
    generateText: () => Ref.update(calls, (n) => n + 1).pipe(Effect.as([
      { type: "text", text: "the finished answer" },
      { type: "finish", reason: "stop", usage: { inputTokens: { total: 900 }, outputTokens: { total: 2 } }, metadata: { [ENGINE_KEY]: { model: "fixture:actual" } } },
    ])),
    streamText: () => Stream.die("not scripted"),
  })
  const turnOn = (over: Sessions["Service"], runId: string, options: { readonly resumes?: number; readonly takeOver?: boolean } = {}) => agent.turn({
    turn: { session, runId: RunId.make(runId), userMessage: new UserMessage({ text: options.resumes === undefined ? "hello" : "Continue." }),
      ...(options.resumes === undefined ? {} : { resumes: options.resumes }), ...(options.takeOver === true ? { takeOver: true } : {}),
      ...(timeLimitMs === undefined ? {} : { timeLimitMs }) },
    services: Context.make(LanguageModel.LanguageModel, model).pipe(Context.add(Sessions, over)),
  }, (current) => current.run({}).pipe(Effect.flatMap((result) => current.reply(result.text))))
  const turn = (runId: string, resumes?: number) => turnOn(sessions, runId, resumes === undefined ? {} : { resumes })
  const successor = Effect.map(instance, (context) => Context.get(context, Sessions))
  const stored = sessions.read(session)
  return { entered, signals, sessions, shutdown, session, turn, turnOn, successor, calls, stored }
})

/** Turn 1 as stored: its end, its reply's outcome and text, and its recorded calls in order. */
const firstTurn = (events: ReadonlyArray<SessionLogEvent>) => Effect.gen(function* () {
  const ended = yield* Effect.forEach(events.filter((event) => event.kind === "turn.ended" && Option.contains(event.turn, 1)), turnEndedOf, { concurrency: 1 })
  const reply = events.find((event) => event.kind === "turn.reply" && Option.contains(event.turn, 1))?.data["body"]
  const calls = (yield* turnModelCallsOf(events, 1)).map((call) => String(call.callId))
  const order = events.filter((event) => Option.contains(event.turn, 1) && ["model.called", "turn.reply", "turn.ended"].includes(event.kind)).map((event) => event.kind)
  return { ended: ended.map((end) => `${end.reason}:${Option.match(end.failure, { onNone: () => "none", onSome: (failure) => failure.code })}`), reply, calls, order }
})

test("journey: the work after a sealed reply runs in the turn, billed there, on the run's reported input", async () => {
  const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { signals, turn, stored } = yield* fixture("record", 701)
    const result = yield* turn("after-reply-record")
    return { result, signals: yield* Ref.get(signals), stored: yield* firstTurn(yield* stored) }
  })))
  expect(observed.result.outcome).toBe("completed")
  expect(observed.signals.map((signal) => signal.phase)).toEqual(["turn-start", "step", "turn-end"])
  expect(observed.signals.at(-1)?.observed?.inputTokens).toBe(900)
  expect(observed.stored.ended).toEqual(["completed:none"])
  expect(observed.stored.calls).toEqual(["summary:1"])
  // The helper's fact is durable before the reply's closing commit.
  expect(observed.stored.order).toEqual(["model.called", "turn.reply", "turn.ended"])
})

test("journey: an interruption during the work after a sealed reply cuts the work only: the turn ends completed with its reply and is never asked again", async () => {
  const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { entered, turn, stored, calls } = yield* fixture("hang", 702)
    const fiber = yield* turn("after-reply-interrupt").pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    yield* Fiber.interrupt(fiber)
    const resume = yield* turn("after-reply-resume", 1).pipe(Effect.result)
    return { stored: yield* firstTurn(yield* stored), resumed: resume._tag === "Failure" ? resume.failure._tag : "resumed", calls: yield* Ref.get(calls) }
  })))
  expect(observed.stored.ended).toEqual(["completed:none"])
  expect(observed.stored.reply).toEqual({ outcome: "completed", reply: "the finished answer" })
  expect(observed.resumed).toBe("NotResumable")
  expect(observed.calls).toBe(1)
})

test("journey: an ordinary failure of the work after a sealed reply is logged and skipped", async () => {
  const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { turn, stored } = yield* fixture("fail", 703)
    const result = yield* turn("after-reply-fail")
    return { result, stored: yield* firstTurn(yield* stored) }
  })))
  expect(observed.result.outcome).toBe("completed")
  expect(observed.stored.ended).toEqual(["completed:none"])
  expect(observed.stored.reply).toEqual({ outcome: "completed", reply: "the finished answer" })
})

test("journey: a time limit during the work after a sealed reply stops the work and the turn ends completed with its reply", async () => {
  const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { turn, stored } = yield* fixture("hang", 704, 1_000)
    const result = yield* turn("after-reply-limit").pipe(Effect.timeout("10 seconds"))
    return { result, stored: yield* firstTurn(yield* stored) }
  })))
  expect(observed.result.outcome).toBe("completed")
  expect(observed.stored.ended).toEqual(["completed:none"])
  expect(observed.stored.reply).toEqual({ outcome: "completed", reply: "the finished answer" })
}, 15_000)

test("journey: a shutdown during the work after a sealed reply stops the work at once and the turn ends completed with its reply", async () => {
  const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { entered, turn, stored, shutdown } = yield* fixture("hang", 705)
    const fiber = yield* turn("after-reply-shutdown").pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    yield* shutdown.refuse
    const closed = yield* shutdown.interrupt
    const result = yield* Fiber.join(fiber).pipe(Effect.timeout("5 seconds"))
    return { closed: closed.length, result, stored: yield* firstTurn(yield* stored) }
  })))
  expect(observed.closed).toBe(1)
  expect(observed.result.outcome).toBe("completed")
  expect(observed.stored.ended).toEqual(["completed:none"])
  expect(observed.stored.reply).toEqual({ outcome: "completed", reply: "the finished answer" })
})

test("journey: a cancel during the work after a sealed reply stops the work and the turn ends completed with its reply", async () => {
  const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { entered, turn, stored, sessions, session, calls } = yield* fixture("hang", 707)
    const fiber = yield* turn("after-reply-cancel").pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    const cancelled = yield* sessions.cancel(session, 1)
    const result = yield* Fiber.join(fiber).pipe(Effect.timeout("5 seconds"))
    const resume = yield* turn("after-reply-cancel-resume", 1).pipe(Effect.result)
    return { cancelled: cancelled.cancelled, result, stored: yield* firstTurn(yield* stored), resumed: resume._tag === "Failure" ? resume.failure._tag : "resumed", calls: yield* Ref.get(calls) }
  })))
  expect(observed.cancelled).toBe(true)
  expect(observed.result.outcome).toBe("completed")
  expect(observed.stored.ended).toEqual(["completed:none"])
  expect(observed.stored.reply).toEqual({ outcome: "completed", reply: "the finished answer" })
  expect(observed.resumed).toBe("NotResumable")
  expect(observed.calls).toBe(1)
})

test("journey: a holder gone during the work after a sealed reply: the takeover stores the turn completed with its reply's text", async () => {
  const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { entered, turn, turnOn, successor, stored, calls } = yield* fixture("hang", 708)
    // The holder hangs in its maintenance, as a process that died there would never write again.
    const holder = yield* turn("after-reply-holder").pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    const next = yield* successor
    const resume = yield* turnOn(next, "after-reply-holder-resume", { resumes: 1, takeOver: true }).pipe(Effect.result)
    const after = yield* turnOn(next, "after-reply-next", { takeOver: true })
    yield* Fiber.interrupt(holder)
    return { stored: yield* firstTurn(yield* stored), resumed: resume._tag === "Failure" ? resume.failure._tag : "resumed", after: after.outcome, calls: yield* Ref.get(calls) }
  })))
  expect(observed.stored.ended).toEqual(["completed:none"])
  expect(observed.stored.reply).toEqual({ outcome: "completed", reply: "the finished answer" })
  expect(observed.resumed).toBe("NotResumable")
  expect(observed.after).toBe("completed")
  // The holder's one call, and the next turn's: the sealed turn is never asked again.
  expect(observed.calls).toBe(2)
})

test("journey: the next run's start is calibrated by the last stored selected response", async () => {
  const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { signals, turn } = yield* fixture("record", 706)
    yield* turn("calibrated-one")
    yield* Ref.set(signals, [])
    yield* turn("calibrated-two")
    return yield* Ref.get(signals)
  })))
  const start = observed.find((signal) => signal.phase === "turn-start")
  expect(start?.observed?.inputTokens).toBe(900)
  expect(start?.observed?.model).toEqual(new ModelSelection({ provider: ProviderId.make("fixture"), modelId: ModelId.make("actual") }))
})
