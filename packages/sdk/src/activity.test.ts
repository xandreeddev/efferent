import { describe, expect, test } from "bun:test"
import { LanguageModel } from "effect/ai"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, Ref, Scope, Stream } from "effect"
import type { Duration } from "effect"
import { TestClock } from "effect/testing"
import {
  awaitIdle,
  ConversationId,
  processActivity,
  SessionLog,
  SessionLogError,
  SessionLogMemoryLive,
  Sessions,
  TaskActivity,
  TaskRunner,
  TurnAdmission,
  TurnAdmissionOpen,
  turnEndedOf,
  TurnRefused,
  UserMessage,
} from "@xandreed/core"
import type { ProcessActivity, SessionLogEvent, Turn } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { sessionsDefaults, SessionsLive, sessionsPlugin, SessionsPluginLive } from "@xandreed/plugin-sessions"
import type { SessionsConfig } from "@xandreed/plugin-sessions"
import { InProcessTaskRunnerLive } from "@xandreed/plugin-tasks"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "./agent.adapter.js"

/*
 * The busy signal (what a `/ping` reports, what a shutdown waits for) and the
 * lease keep-alive, through `Agent`: the turns Sessions holds open, the work
 * the task runner runs, a SIGTERM drain, and a silent model call longer than
 * the lease.
 */

const usage = { inputTokens: { total: 100 }, outputTokens: { total: 10 } }
const stop = (text: string) => [{ type: "text", text }, { type: "finish", reason: "stop", usage }]

/** A provider that answers after `delay` (Clock time), saying when it was called. */
const answering = (delay: Duration.Input, called: Deferred.Deferred<void>) => LanguageModel.make({
  generateText: () => Deferred.succeed(called, undefined).pipe(Effect.andThen(Effect.sleep(delay)), Effect.as(stop("done") as never)),
  streamText: () => Stream.die("not scripted") as never,
})

const session = { id: ConversationId.make("00000000-0000-4000-8000-0000000000b1"), owner: "ops" }
const ask = (runId: string, text = "hello") => ({ session, userMessage: new UserMessage({ text }), runId })
const onCommit: SessionsConfig = { ...sessionsDefaults, ownership: { mode: "lease", ttlMs: 60_000, renew: "on-commit" } }

const define = (extra: { readonly plugins?: ReadonlyArray<typeof sessionsPlugin>; readonly services?: Context.Context<never> } = {}) => Agent.define({
  plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin, ...(extra.plugins ?? [])],
  turnServices: [LanguageModel.LanguageModel],
  limits: { streaming: false, maxSteps: 3 },
  ...(extra.services === undefined ? {} : { services: extra.services }),
})

/** Run the loop until the model stops; the reply is its text. */
const runToEnd = (turn: Turn) => turn.run({}).pipe(Effect.map((result) => ({ outcome: result.outcome, reply: Option.some(result.text) })))

const endings = (events: ReadonlyArray<SessionLogEvent>) => events.filter((event) => event.kind === "turn.ended").map((event) => event.data.reason)

const idle: ProcessActivity = { openTurns: [], beginningTurns: 0, runningTasks: 0, busy: false }

describe("Agent.activity", () => {
  test("it counts the turn its graph's Sessions holds open and the work of the task runner in its services", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const services = yield* Layer.build(Layer.mergeAll(SessionLogMemoryLive, TurnAdmissionOpen, InProcessTaskRunnerLive()))
    const agent = yield* define({ plugins: [sessionsPlugin], services })
    expect(yield* agent.activity).toEqual(idle)
    // The session is created through another Sessions over the same log; the turn uses the graph's.
    const creator = Context.get(yield* Layer.build(SessionsLive(onCommit).pipe(Layer.provide(Layer.succeedContext(services)))), Sessions)
    yield* creator.create({ owner: session.owner, id: session.id })
    const release = yield* Deferred.make<void>()
    yield* Context.get(services, TaskRunner).run(() => Deferred.await(release))
    const during = yield* Ref.make(Option.none<ProcessActivity>())
    const model = yield* answering("0 seconds", yield* Deferred.make<void>())
    const result = yield* agent.turn({ turn: ask("run-1"), services: Context.make(LanguageModel.LanguageModel, model) }, (turn) =>
      agent.activity.pipe(Effect.flatMap((now) => Ref.set(during, Option.some(now))), Effect.andThen(turn.reply("ok"))))
    expect(result.outcome).toBe("completed")
    const seen = Option.getOrThrow(yield* Ref.get(during))
    expect([seen.openTurns.map((open) => [open.session, open.turn]), seen.runningTasks, seen.busy]).toEqual([[[session.id, 1]], 1, true])
    expect(yield* agent.activity).toEqual({ ...idle, runningTasks: 1, busy: true })
    yield* Deferred.succeed(release, undefined)
    yield* Context.get(services, TaskActivity).idle
    expect(yield* agent.activity).toEqual(idle)
  }))))

  test("a Sessions the host passes only in a turn's services is not the agent's to see: processActivity over the host's services is", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const services = yield* Layer.build(SessionsLive(onCommit).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen))))
    const sessions = Context.get(services, Sessions)
    yield* sessions.create({ owner: session.owner, id: session.id })
    const agent = yield* define()
    const model = yield* answering("0 seconds", yield* Deferred.make<void>())
    const seen = yield* Ref.make<ReadonlyArray<boolean>>([])
    yield* agent.turn({ turn: ask("run-1"), services: Context.merge(Context.make(LanguageModel.LanguageModel, model), services) }, (turn) => Effect.gen(function* () {
      const agents = yield* agent.activity
      const hosts = yield* processActivity.pipe(Effect.provide(services))
      yield* Ref.set(seen, [agents.busy, hosts.busy])
      return yield* turn.reply("ok")
    }))
    expect(yield* Ref.get(seen)).toEqual([false, true])
  }))))
})

describe("a SIGTERM drain: stop admitting, wait until idle, close", () => {
  test("a turn and a task in flight finish, a new turn is refused, and the services close once idle", () => Effect.runPromise(Effect.gen(function* () {
    // The host's process-lifetime services, in a scope it closes on SIGTERM.
    const draining = yield* Ref.make(false)
    const admission = Layer.succeed(TurnAdmission, TurnAdmission.of({
      admit: (turn, open) => Effect.gen(function* () {
        if (yield* Ref.get(draining)) return yield* Effect.fail(new TurnRefused({ session: turn.session.id, reason: "draining", message: "the server is shutting down" }))
        return yield* open
      }),
    }))
    const scope = yield* Scope.make()
    // The runner on top of the sessions: closing interrupts its tasks first, while their log is open.
    const sessionsLayer = SessionsPluginLive({ ownership: { mode: "process" } }).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, admission)))
    const services = yield* Layer.build(InProcessTaskRunnerLive().pipe(Layer.provideMerge(sessionsLayer))).pipe(Scope.provide(scope))
    const sessions = Context.get(services, Sessions)
    yield* sessions.create({ owner: session.owner, id: session.id })
    const agent = yield* define().pipe(Scope.provide(scope))
    const model = yield* answering("0 seconds", yield* Deferred.make<void>())
    const turnServices = Context.merge(Context.make(LanguageModel.LanguageModel, model), services)

    // In flight: a turn waiting on the host, and a background task.
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const inFlight = yield* Effect.forkChild(agent.turn({ turn: ask("run-1", "a long request"), services: turnServices }, (turn) =>
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(turn.reply("finished")))))
    yield* Deferred.await(started)
    yield* Context.get(services, TaskRunner).run(() => Deferred.await(release))
    const ping = yield* processActivity.pipe(Effect.provide(services))
    expect([ping.busy, ping.openTurns.length, ping.runningTasks]).toEqual([true, 1, 1])

    // SIGTERM: stop admitting, then wait (bounded) until nothing is open or running.
    yield* Ref.set(draining, true)
    const refused = yield* Effect.flip(agent.turn({ turn: ask("run-2", "too late"), services: turnServices }, runToEnd))
    expect(refused.code).toBe("turn.refused")
    const drained = yield* Effect.forkChild(awaitIdle({ timeout: "25 seconds" }).pipe(Effect.provide(services)))
    yield* Effect.yieldNow
    expect(drained.pollUnsafe()).toBeUndefined()
    yield* Deferred.succeed(release, undefined)
    expect((yield* Fiber.join(inFlight)).outcome).toBe("completed")
    expect(yield* Fiber.join(drained)).toEqual(idle)
    const stored = yield* sessions.read(session)
    yield* Scope.close(scope, Exit.void)
    expect(endings(stored)).toEqual(["completed"])
  })))
})

describe("a drain that times out: stop the requests, then close the services", () => {
  /** A log that refuses every commit once its layer's scope has closed, as a SQLite log does once its database is closed. */
  const closingOver = (store: Context.Service.Shape<typeof SessionLog>) => Layer.effect(SessionLog, Effect.gen(function* () {
    const closed = yield* Ref.make(false)
    yield* Effect.addFinalizer(() => Ref.set(closed, true))
    return SessionLog.of({ ...store, commit: (id, input) => Ref.get(closed).pipe(Effect.flatMap((done) => done
      ? Effect.fail(new SessionLogError({ code: "store.closed", message: "the log is closed" }))
      : store.commit(id, input))) })
  }))

  test("a request's turn and a task's turn still running both end interrupted, stored before the log closes", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = Context.get(yield* Layer.build(SessionLogMemoryLive), SessionLog)
    const scope = yield* Scope.make()
    const sessionsLayer = SessionsPluginLive({ ownership: { mode: "process" } }).pipe(Layer.provide(Layer.merge(closingOver(store), TurnAdmissionOpen)))
    const services = yield* Layer.build(InProcessTaskRunnerLive().pipe(Layer.provideMerge(sessionsLayer))).pipe(Scope.provide(scope))
    const sessions = Context.get(services, Sessions)
    const child = { id: ConversationId.make("00000000-0000-4000-8000-0000000000b2"), owner: session.owner }
    yield* sessions.create({ owner: session.owner, id: session.id })
    yield* sessions.create({ owner: child.owner, id: child.id })
    const agent = yield* define().pipe(Scope.provide(scope))
    const model = yield* answering("0 seconds", yield* Deferred.make<void>())

    // A request whose turn never finishes, and a task whose child turn never finishes.
    const requested = yield* Deferred.make<void>()
    const request = yield* Effect.forkChild(agent.turn({ turn: ask("run-1"), services: Context.merge(Context.make(LanguageModel.LanguageModel, model), services) }, () =>
      Deferred.succeed(requested, undefined).pipe(Effect.andThen(Effect.never))))
    yield* Deferred.await(requested)
    const tasked = yield* Deferred.make<void>()
    yield* Context.get(services, TaskRunner).run(() => Effect.scoped(sessions.begin(child, { _tag: "User", userMessage: new UserMessage({ text: "work" }), runId: "task-1", key: "task-1", command: {} }).pipe(
      Effect.andThen(Deferred.succeed(tasked, undefined)), Effect.andThen(Effect.never))).pipe(Effect.ignore))
    yield* Deferred.await(tasked)

    const left = yield* awaitIdle({ timeout: "20 millis" }).pipe(Effect.provide(services))
    expect([left.busy, left.openTurns.length, left.runningTasks]).toEqual([true, 2, 1])
    // The host's requests first (its HTTP server's shutdown), then the services: the runner closes before the log.
    yield* Fiber.interrupt(request)
    yield* Scope.close(scope, Exit.void)
    const stored = (id: ConversationId) => store.read(id, { after: 0, limit: Option.none(), kinds: ["turn.ended"] }).pipe(
      Effect.flatMap((events) => Effect.forEach(events, turnEndedOf)),
      Effect.map((ended) => ended.map((end) => [end.reason, Option.getOrNull(Option.map(end.failure, (failure) => failure.code))])))
    expect(yield* stored(session.id)).toEqual([["interrupted", "turn.interrupted"]])
    expect(yield* stored(child.id)).toEqual([["interrupted", "turn.interrupted"]])
  }))))
})

describe("lease keep-alive", () => {
  /** One turn whose only model call takes 90 s of Clock time, without a write, under a 60 s lease renewed as given. */
  const silentStep = (config: SessionsConfig) => Effect.scoped(Effect.gen(function* () {
    const sessions = Context.get(yield* Layer.build(SessionsLive(config).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
    yield* sessions.create({ owner: session.owner, id: session.id })
    const agent = yield* define()
    const called = yield* Deferred.make<void>()
    const model = yield* answering("90 seconds", called)
    const running = yield* Effect.forkChild(Effect.result(agent.turn({ turn: ask("run-1"), services: Context.merge(Context.make(LanguageModel.LanguageModel, model), Context.make(Sessions, sessions)) }, runToEnd)))
    yield* Deferred.await(called)
    yield* Effect.forEach([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], () => TestClock.adjust("10 seconds"), { discard: true })
    const result = yield* Fiber.join(running)
    const view = yield* sessions.get(session)
    return {
      result: result._tag === "Success" ? result.success.outcome : result.failure.code,
      stored: endings(yield* sessions.read(session)),
      open: Option.isSome(view.open),
    }
  })).pipe(Effect.provide(TestClock.layer()))

  test("a model call longer than the lease keeps it with the default keep-alive", () => Effect.runPromise(Effect.gen(function* () {
    expect(yield* silentStep(sessionsDefaults)).toEqual({ result: "completed", stored: ["completed"], open: false })
  })))

  test("and loses it when only commits renew it: the turn is closed and its lease has run out", () => Effect.runPromise(Effect.gen(function* () {
    expect(yield* silentStep(onCommit)).toEqual({ result: "turn.closed", stored: [], open: false })
  })))
})
