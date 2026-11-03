import { describe, expect, test } from "bun:test"
import { Clock, Context, Deferred, Effect, Fiber, Layer, Ref, Schema, Stream, SubscriptionRef } from "effect"
import { TestClock } from "effect/testing"
import {
  BackgroundWorkers, CommittedTurnObservers, ConversationId, definePlugin, RunId, SessionLogMemoryLive, Sessions,
  TaskRunner, TurnAdmissionOpen, UserMessage,
} from "@xandreed/core"
import type { BackgroundWorker } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { sessionsDefaults, SessionsLive, sessionsPlugin } from "@xandreed/plugin-sessions"
import { InProcessTaskRunnerLive } from "@xandreed/plugin-tasks"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "./agent.adapter.js"

const basePlugins = [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin, sessionsPlugin]
const address = { owner: "fixture", id: ConversationId.make("00000000-0000-4000-8000-0000000000c3") }
const runtime = Layer.mergeAll(SessionLogMemoryLive, TurnAdmissionOpen, InProcessTaskRunnerLive())
const untilIdle = (running: SubscriptionRef.SubscriptionRef<number>) => SubscriptionRef.changes(running).pipe(Stream.filter((count) => count === 0), Stream.take(1), Stream.runDrain)
const workerPlugin = (worker: BackgroundWorker) => definePlugin({
  id: "fixture/worker", version: "1", scope: "runtime", config: Schema.Struct({}), defaults: {}, provides: [], contributes: [BackgroundWorkers],
  layer: () => Layer.succeed(BackgroundWorkers, [worker]),
})

describe("native runtime workers through Agent", () => {
  test("activity counts a task runner and native work independently, and shutdown waits for both", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const services = yield* Layer.build(runtime)
    const running = yield* SubscriptionRef.make(1)
    const stopped = yield* Ref.make(false)
    const releaseTask = yield* Deferred.make<void>()
    const started = yield* Deferred.make<void>()
    yield* Context.get(services, TaskRunner).run(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(releaseTask))))
    yield* Deferred.await(started)
    const agent = yield* Agent.define({ plugins: [...basePlugins, workerPlugin({
      id: "native", running: SubscriptionRef.get(running), idle: untilIdle(running), stop: Ref.set(stopped, true), interrupt: Effect.die("finished work must not be interrupted"),
    })], services })
    expect(yield* agent.activity).toMatchObject({ runningTasks: 1, runningWorkers: 1, inFlight: true })
    const shutting = yield* Effect.forkChild(agent.shutdown({ deadline: "5 seconds" }))
    yield* Deferred.succeed(releaseTask, undefined)
    yield* Effect.yieldNow
    expect(shutting.pollUnsafe()).toBeUndefined()
    expect(yield* Ref.get(stopped)).toBe(false)
    yield* SubscriptionRef.set(running, 0)
    expect(yield* Fiber.join(shutting)).toMatchObject({ idle: true, left: { runningTasks: 0, runningWorkers: 0, inFlight: false } })
    expect(yield* Ref.get(stopped)).toBe(true)
  }))))

  test("admitted turns enqueue after commit before shutdown stops worker claims", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const services = yield* Layer.build(runtime)
    const calls = yield* Ref.make<ReadonlyArray<string>>([])
    const running = yield* SubscriptionRef.make(0)
    const entered = yield* Deferred.make<void>()
    const releaseTurn = yield* Deferred.make<void>()
    const captured = yield* Deferred.make<void>()
    const capture = definePlugin({
      id: "fixture/capture", version: "1", scope: "session", config: Schema.Struct({}), defaults: {}, requires: [Sessions], provides: [], contributes: [CommittedTurnObservers],
      layer: () => Layer.effect(CommittedTurnObservers, Effect.gen(function* () {
        const sessions = yield* Sessions
        return [{ id: "capture", committed: (turn) => Effect.gen(function* () {
          expect((yield* sessions.read(turn.session).pipe(Effect.orDie)).at(-1)?.kind).toBe("turn.ended")
          yield* Ref.update(calls, (all) => [...all, "enqueued"])
          yield* SubscriptionRef.set(running, 1)
          yield* Deferred.succeed(captured, undefined)
        }) }]
      })),
    })
    const agent = yield* Agent.define({ plugins: [...basePlugins, capture, workerPlugin({
      id: "native", running: SubscriptionRef.get(running), idle: untilIdle(running), stop: Ref.update(calls, (all) => [...all, "stopped"]), interrupt: Effect.die("finished work must not be interrupted"),
    })], services })
    // A second Sessions handle creates the source over the same durable log.
    const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.succeedContext(services)))), Sessions)
    yield* sessions.create({ owner: address.owner, id: address.id })
    const turning = yield* Effect.forkChild(agent.turn({ turn: { session: address, runId: RunId.make("worker-capture"), userMessage: new UserMessage({ text: "hello" }) }, services: Context.empty() },
      (turn) => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(releaseTurn)), Effect.andThen(turn.reply("answer")))))
    yield* Deferred.await(entered)
    const shutting = yield* Effect.forkChild(agent.shutdown({ deadline: "5 seconds" }))
    yield* Effect.yieldNow
    expect(yield* Ref.get(calls)).toEqual([])
    yield* Deferred.succeed(releaseTurn, undefined)
    yield* Deferred.await(captured)
    yield* Fiber.join(turning)
    expect(yield* Ref.get(calls)).toEqual(["enqueued"])
    yield* SubscriptionRef.set(running, 0)
    expect((yield* Fiber.join(shutting)).idle).toBe(true)
    expect(yield* Ref.get(calls)).toEqual(["enqueued", "stopped"])
  }))))

  test("worker cleanup uses the original shutdown deadline", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const services = yield* Layer.build(runtime)
    const calls = yield* Ref.make<ReadonlyArray<string>>([])
    const agent = yield* Agent.define({ plugins: [...basePlugins, workerPlugin({
      id: "blocked", running: Effect.succeed(1), idle: Effect.never,
      stop: Ref.update(calls, (all) => [...all, "stop"]),
      interrupt: Ref.update(calls, (all) => [...all, "interrupt"]).pipe(Effect.andThen(Effect.sleep("1 second"))),
    })], services })
    const before = yield* Clock.currentTimeMillis
    const shutting = yield* Effect.forkChild(agent.shutdown({ deadline: "200 millis", reserve: "100 millis" }))
    yield* TestClock.adjust("200 millis")
    const report = yield* Fiber.join(shutting)
    expect((yield* Clock.currentTimeMillis) - before).toBe(200)
    expect(report.left).toMatchObject({ runningWorkers: 1, inFlight: true })
    expect(yield* Ref.get(calls)).toEqual(["stop", "interrupt"])
  })).pipe(Effect.provide(TestClock.layer()))))
})
