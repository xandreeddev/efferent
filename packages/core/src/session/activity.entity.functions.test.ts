import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Ref, Stream, SubscriptionRef } from "effect"
import { TestClock } from "effect/testing"
import { ConversationId } from "../domain/message.entity.js"
import { DrainActivity, TaskActivity, TurnActivity, TurnShutdown, WaitingInput } from "../ports/activity.port.js"
import { awaitIdle, processActivity, shutdownGracefully } from "./activity.entity.functions.js"
import type { ActiveTurn, TurnsInFlight } from "./activity.entity.js"
import { SessionLogError } from "./session-log.entity.js"

const session = ConversationId.make("00000000-0000-4000-8000-0000000000a1")
const turn = (number: number, since: number): ActiveTurn => ({ session, turn: number, since })
const opened = (...open: ReadonlyArray<ActiveTurn>): TurnsInFlight => ({ open, beginning: 0 })
const idle = { openTurns: [], beginningTurns: 0, runningTasks: 0, waiting: [], queuedInput: 0, inFlight: false, busy: false, stopping: false }
const pending = [{ session, pending: 2 }]
const queued = { ...idle, waiting: pending, queuedInput: 2, busy: true }
const queueError = new SessionLogError({ code: "store.busy", message: "queue unavailable" })

/** Probes over two refs the test sets: the turns in flight, and the work running. */
const probes = Effect.gen(function* () {
  const turns = yield* SubscriptionRef.make<TurnsInFlight>(opened())
  const tasks = yield* SubscriptionRef.make(0)
  const until = <A>(ref: SubscriptionRef.SubscriptionRef<A>, done: (value: A) => boolean) =>
    SubscriptionRef.changes(ref).pipe(Stream.filter(done), Stream.take(1), Stream.runDrain)
  const provide = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(
    Effect.provideService(TurnActivity, TurnActivity.of({ current: SubscriptionRef.get(turns), idle: until(turns, (now) => now.open.length === 0 && now.beginning === 0) })),
    Effect.provideService(TaskActivity, TaskActivity.of({ running: SubscriptionRef.get(tasks), idle: until(tasks, (running) => running === 0) })),
  )
  return { turns, tasks, provide }
})

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect.pipe(Effect.provide(TestClock.layer())))

describe("processActivity", () => {
  test("without probes nothing is open and nothing runs", () => run(Effect.gen(function* () {
    expect(yield* processActivity).toEqual(idle)
    expect(yield* awaitIdle()).toEqual(idle)
  })))

  test("it is busy while a turn is open or beginning or a task runs, and lists the open turns", () => run(Effect.gen(function* () {
    const { turns, tasks, provide } = yield* probes
    yield* SubscriptionRef.set(turns, opened(turn(3, 1_000)))
    expect(yield* provide(processActivity)).toEqual({ ...idle, openTurns: [turn(3, 1_000)], inFlight: true, busy: true })
    yield* SubscriptionRef.set(turns, { open: [], beginning: 1 })
    expect(yield* provide(processActivity)).toEqual({ ...idle, beginningTurns: 1, inFlight: true, busy: true })
    yield* SubscriptionRef.set(turns, opened())
    yield* SubscriptionRef.set(tasks, 2)
    expect(yield* provide(processActivity)).toEqual({ ...idle, runningTasks: 2, inFlight: true, busy: true })
    yield* SubscriptionRef.set(tasks, 0)
    expect((yield* provide(processActivity)).busy).toBe(false)
  })))

  test("queued input is busy without in-flight work, and zero counts are omitted", () => run(processActivity.pipe(
    Effect.provideService(WaitingInput, WaitingInput.of({ current: Effect.succeed([...pending, { session, pending: 0 }]), cached: Effect.succeed([]), idle: Effect.never })),
    Effect.tap((now) => Effect.sync(() => expect(now).toEqual(queued))),
  )))

  test("an installed queue probe's failure is preserved instead of becoming idle", () => run(Effect.gen(function* () {
    const failed = yield* Effect.result(processActivity.pipe(Effect.provideService(WaitingInput, WaitingInput.of({ current: Effect.fail(queueError), cached: Effect.succeed(pending), idle: Effect.fail(queueError) }))))
    expect(failed._tag === "Failure" && failed.failure).toBe(queueError)
  })))

  test("an active drain is in flight even before it opens a turn", () => run(processActivity.pipe(
    Effect.provideService(DrainActivity, DrainActivity.of({ running: Effect.succeed(1), idle: Effect.never })),
    Effect.tap((now) => Effect.sync(() => expect(now).toEqual({ ...idle, inFlight: true, busy: true }))),
  )))
})

describe("awaitIdle", () => {
  test("it resolves once the turns and the tasks have both settled", () => run(Effect.gen(function* () {
    const { turns, tasks, provide } = yield* probes
    yield* SubscriptionRef.set(turns, opened(turn(1, 0)))
    yield* SubscriptionRef.set(tasks, 1)
    const waiting = yield* Effect.forkChild(provide(awaitIdle()))
    yield* SubscriptionRef.set(turns, opened())
    yield* Effect.yieldNow
    expect(waiting.pollUnsafe()).toBeUndefined()
    yield* SubscriptionRef.set(tasks, 0)
    expect(yield* Fiber.join(waiting)).toEqual(idle)
  })))

  test("a begin still in progress is waited for, and so is the turn it opens", () => run(Effect.gen(function* () {
    const { turns, provide } = yield* probes
    yield* SubscriptionRef.set(turns, { open: [], beginning: 1 })
    const waiting = yield* Effect.forkChild(provide(awaitIdle()))
    yield* Effect.yieldNow
    expect(waiting.pollUnsafe()).toBeUndefined()
    yield* SubscriptionRef.set(turns, opened(turn(1, 0)))
    yield* Effect.yieldNow
    expect(waiting.pollUnsafe()).toBeUndefined()
    yield* SubscriptionRef.set(turns, opened())
    expect(yield* Fiber.join(waiting)).toEqual(idle)
  })))

  test("a turn a task opened before it ended is waited for too", () => run(Effect.gen(function* () {
    const { turns, tasks, provide } = yield* probes
    yield* SubscriptionRef.set(tasks, 1)
    const waiting = yield* Effect.forkChild(provide(awaitIdle()))
    yield* Effect.yieldNow
    // The task opens its parent's inbox turn, then ends: no moment has both idle.
    yield* SubscriptionRef.set(turns, opened(turn(2, 5)))
    yield* SubscriptionRef.set(tasks, 0)
    yield* Effect.yieldNow
    expect(waiting.pollUnsafe()).toBeUndefined()
    yield* SubscriptionRef.set(turns, opened())
    expect((yield* Fiber.join(waiting)).busy).toBe(false)
  })))

  test("with a timeout it stops waiting then and returns what is still busy", () => run(Effect.gen(function* () {
    const { turns, tasks, provide } = yield* probes
    yield* SubscriptionRef.set(turns, opened(turn(4, 0)))
    yield* SubscriptionRef.set(tasks, 1)
    const waiting = yield* Effect.forkChild(provide(awaitIdle({ timeout: "5 seconds" })))
    yield* TestClock.adjust("5 seconds")
    expect(yield* Fiber.join(waiting)).toEqual({ ...idle, openTurns: [turn(4, 0)], runningTasks: 1, inFlight: true, busy: true })
    // Within the timeout it returns as soon as everything settles.
    const settling = yield* Effect.forkChild(provide(awaitIdle({ timeout: "5 seconds" })))
    yield* SubscriptionRef.set(turns, opened())
    yield* SubscriptionRef.set(tasks, 0)
    expect(yield* Fiber.join(settling)).toEqual(idle)
  })))

  test("queued false skips every fresh queue operation and retains its cached backlog", () => run(Effect.gen(function* () {
    const result: Effect.Effect<unknown> = awaitIdle({ queued: false }).pipe(Effect.provideService(WaitingInput, WaitingInput.of({
      current: Effect.die("queued false read queue storage"), cached: Effect.succeed(pending), idle: Effect.die("queued false waited for queue storage"),
    })))
    expect(yield* result).toEqual(queued)
  })))

  test("the default waits for queued input and reads fresh state once it settles", () => run(Effect.gen(function* () {
    const waiting = yield* SubscriptionRef.make(pending)
    const calls = yield* Ref.make(0)
    const probe = WaitingInput.of({
      current: Ref.update(calls, (n) => n + 1).pipe(Effect.andThen(SubscriptionRef.get(waiting))),
      cached: SubscriptionRef.get(waiting),
      idle: SubscriptionRef.changes(waiting).pipe(Stream.filter((now) => now.length === 0), Stream.take(1), Stream.runDrain),
    })
    const settled = yield* Effect.forkChild(awaitIdle().pipe(Effect.provideService(WaitingInput, probe)))
    yield* Effect.yieldNow
    expect(settled.pollUnsafe()).toBeUndefined()
    yield* SubscriptionRef.set(waiting, [])
    expect(yield* Fiber.join(settled)).toEqual(idle)
    expect(yield* Ref.get(calls)).toBeGreaterThan(0)
  })))

  test("a queue idle failure is preserved", () => run(Effect.gen(function* () {
    const result = yield* Effect.result(awaitIdle().pipe(Effect.provideService(WaitingInput, WaitingInput.of({
      current: Effect.succeed(pending), cached: Effect.succeed(pending), idle: Effect.fail(queueError),
    }))))
    expect(result._tag === "Failure" && result.failure).toBe(queueError)
  })))

  test("a timeout returns cached counts without starting another queue storage read", () => run(Effect.gen(function* () {
    const reads = yield* Ref.make(0)
    const entered = yield* Deferred.make<void>()
    const probe = WaitingInput.of({
      current: Ref.update(reads, (n) => n + 1).pipe(Effect.andThen(Deferred.succeed(entered, undefined)), Effect.andThen(Effect.never)),
      cached: Effect.succeed(pending), idle: Effect.void,
    })
    const waiting = yield* Effect.forkChild(awaitIdle({ timeout: "5 seconds" }).pipe(Effect.provideService(WaitingInput, probe)))
    yield* Deferred.await(entered)
    yield* TestClock.adjust("5 seconds")
    expect(yield* Fiber.join(waiting)).toEqual(queued)
    expect(yield* Ref.get(reads)).toBe(1)
  })))

  test("drain work started while a task settles is waited for too", () => run(Effect.gen(function* () {
    const { tasks, provide } = yield* probes
    const draining = yield* SubscriptionRef.make(0)
    yield* SubscriptionRef.set(tasks, 1)
    const waiting = yield* Effect.forkChild(provide(awaitIdle({ queued: false }).pipe(Effect.provideService(DrainActivity, DrainActivity.of({
      running: SubscriptionRef.get(draining), idle: SubscriptionRef.changes(draining).pipe(Stream.filter((now) => now === 0), Stream.take(1), Stream.runDrain),
    })))))
    yield* Effect.yieldNow
    yield* SubscriptionRef.set(draining, 1)
    yield* SubscriptionRef.set(tasks, 0)
    yield* Effect.yieldNow
    expect(waiting.pollUnsafe()).toBeUndefined()
    yield* SubscriptionRef.set(draining, 0)
    expect(yield* Fiber.join(waiting)).toEqual(idle)
  })))
})

describe("shutdownGracefully", () => {
  /** A TurnShutdown over the probes: it records each call, and its interrupt closes every open turn. */
  const stopping = (turns: SubscriptionRef.SubscriptionRef<TurnsInFlight>) => Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([])
    const shutdown = TurnShutdown.of({
      refuse: Ref.update(calls, (all) => [...all, "refuse"]),
      stopping: Ref.get(calls).pipe(Effect.map((all) => all.length > 0)),
      interrupt: Effect.gen(function* () {
        yield* Ref.update(calls, (all) => [...all, "interrupt"])
        const open = (yield* SubscriptionRef.get(turns)).open
        yield* SubscriptionRef.set(turns, opened())
        return open
      }),
    })
    return { calls, provideShutdown: <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.provideService(TurnShutdown, shutdown)) }
  })

  test("it refuses first, and returns at once when the process is idle before the deadline", () => run(Effect.gen(function* () {
    const { turns, provide } = yield* probes
    const { calls, provideShutdown } = yield* stopping(turns)
    yield* SubscriptionRef.set(turns, opened(turn(1, 0)))
    const shutting = yield* Effect.forkChild(provide(provideShutdown(shutdownGracefully({ deadline: "10 seconds" }))))
    yield* Effect.yieldNow
    expect(yield* Ref.get(calls)).toEqual(["refuse"])
    yield* SubscriptionRef.set(turns, opened())
    expect(yield* Fiber.join(shutting)).toEqual({ idle: true, interrupted: [], left: { ...idle, stopping: true } })
    expect(yield* Ref.get(calls)).toEqual(["refuse"])
  })))

  test("retained queued input does not consume the shutdown deadline or trigger interruption", () => run(Effect.gen(function* () {
    const { turns, provide } = yield* probes
    const { calls, provideShutdown } = yield* stopping(turns)
    const report = yield* provide(provideShutdown(shutdownGracefully({ deadline: "10 seconds" }).pipe(Effect.provideService(WaitingInput, WaitingInput.of({
      current: Effect.die("shutdown read queue storage"), cached: Effect.succeed(pending), idle: Effect.never,
    })))))
    expect(report).toEqual({ idle: true, interrupted: [], left: { ...queued, stopping: true } })
    expect(yield* Ref.get(calls)).toEqual(["refuse"])
  })))

  test("at the deadline less its reserve it interrupts what is still open, then waits out the reserve", () => run(Effect.gen(function* () {
    const { turns, tasks, provide } = yield* probes
    const { calls, provideShutdown } = yield* stopping(turns)
    yield* SubscriptionRef.set(turns, opened(turn(1, 0), turn(2, 5)))
    yield* SubscriptionRef.set(tasks, 1)
    const shutting = yield* Effect.forkChild(provide(provideShutdown(shutdownGracefully({ deadline: "10 seconds", reserve: "3 seconds" }))))
    yield* TestClock.adjust("6999 millis")
    expect(yield* Ref.get(calls)).toEqual(["refuse"])
    yield* TestClock.adjust("1 millis")
    expect(yield* Ref.get(calls)).toEqual(["refuse", "interrupt"])
    // The task its interrupted turn ran ends within the reserve.
    yield* SubscriptionRef.set(tasks, 0)
    expect(yield* Fiber.join(shutting)).toEqual({ idle: false, interrupted: [turn(1, 0), turn(2, 5)], left: { ...idle, stopping: true } })
  })))

  test("what is still in flight after the reserve is reported busy; without a TurnShutdown nothing is interrupted", () => run(Effect.gen(function* () {
    const { turns, provide } = yield* probes
    yield* SubscriptionRef.set(turns, opened(turn(1, 0)))
    const shutting = yield* Effect.forkChild(provide(shutdownGracefully({ deadline: "1 second", reserve: "5 seconds" })))
    // A reserve longer than the deadline is the whole deadline: no wait before the interrupt, which has nothing to call.
    yield* TestClock.adjust("1 second")
    const report = yield* Fiber.join(shutting)
    expect([report.idle, report.interrupted, report.left.busy, report.left.openTurns]).toEqual([false, [], true, [turn(1, 0)]])
  })))
})
