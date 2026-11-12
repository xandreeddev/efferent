import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, Ref, Schema, Scope, Stream } from "effect"
import { makeCore } from "./core.adapter.js"
import { Core } from "./core.port.js"
import { live, liveEvent } from "./event.entity.functions.js"
import type { KernelEvent } from "./event.entity.js"
import { SessionId, TurnNumber } from "./ids.entity.js"
import { definePlugin } from "./plugin.adapter.js"
import { listenerFailed } from "./vocabulary.entity.functions.js"
import { listenerFailedEvent } from "./vocabulary.entity.js"
import { ListenerFailed } from "./event.entity.js"

const origin = { id: SessionId.make("s-1"), turn: TurnNumber.make(1) }
const ticked = liveEvent("clock", "ticked", { data: Schema.Struct({ n: Schema.Int }) })
const tocked = liveEvent("clock", "tocked", { data: Schema.Struct({ n: Schema.Int }) })
const tick = (n: number) => live(ticked, origin, { n })
/** An event no listener waits for: published after something, it marks "everything before this has been handed over". */
const probe = live(tocked, origin, { n: 0 })

class Broken extends Schema.TaggedError<Broken>()("Broken", { message: Schema.String }) {}

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect))

/** Everything the hub hands over, in its order, up to and including the probe; reading from now. */
const untilProbe = (core: Effect.Success<ReturnType<typeof makeCore>>) =>
  Effect.forkScoped(Stream.runCollect(Stream.takeUntil(core.events, (event) => event.name === tocked.name)), { startImmediately: true })

describe("Core.publish", () => {
  test("runs the waiting listeners in the order they registered, one after another, before it returns", async () => {
    const log = await run(Effect.gen(function* () {
      const core = yield* makeCore()
      const log = yield* Ref.make<ReadonlyArray<string>>([])
      const note = (entry: string) => Ref.update(log, (all) => [...all, entry])
      yield* core.on(ticked, (event) => Effect.andThen(note(`first ${event.data.n} in`), Effect.andThen(Effect.yieldNow, note(`first ${event.data.n} out`))), { wait: true })
      yield* core.on(tocked, () => note("not for this event"), { wait: true })
      yield* core.on(ticked, (event) => note(`second ${event.data.n}`), { wait: true })
      yield* core.publish(tick(1))
      yield* note("published 1")
      yield* core.publish(tick(2))
      return yield* Ref.get(log)
    }))
    expect(log).toEqual(["first 1 in", "first 1 out", "second 1", "published 1", "first 2 in", "first 2 out", "second 2"])
  })

  test("hands the event to the hub only after the waiting listeners are done", async () => {
    const order = await run(Effect.gen(function* () {
      const core = yield* makeCore()
      const entered = yield* Deferred.make<void>()
      const go = yield* Deferred.make<void>()
      const handed = yield* untilProbe(core)
      yield* core.on(ticked, () => Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(go)), { wait: true })
      const publisher = yield* Effect.forkChild(core.publish(tick(1)))
      yield* Deferred.await(entered)
      // The waiting listener holds the first event. An event published now reaches the hub before it: were the
      // hub handed an event before its waiting listeners ran, the tick would be there first.
      yield* core.publish(live(liveEvent("clock", "chimed", { data: Schema.Struct({}) }), origin, {}))
      yield* Deferred.succeed(go, undefined)
      yield* Fiber.join(publisher)
      yield* core.publish(probe)
      return (yield* Fiber.join(handed)).map((event): string => event.name)
    }))
    expect(order).toEqual(["plugin.clock.chimed", "plugin.clock.ticked", "plugin.clock.tocked"])
  })

  test("does not wait for a background listener, even one that never returns", async () => {
    const heard = await run(Effect.gen(function* () {
      const core = yield* makeCore()
      const heard = yield* Deferred.make<number>()
      yield* core.on(ticked, () => Effect.never)
      yield* core.on(ticked, (event) => Deferred.succeed(heard, event.data.n))
      yield* core.publish(tick(1))
      return yield* Deferred.await(heard)
    }))
    expect(heard).toBe(1)
  })

  test("fails with the listener and the event named when a waiting listener fails, and runs none after it", async () => {
    const result = await run(Effect.gen(function* () {
      const core = yield* makeCore()
      const ran = yield* Ref.make<ReadonlyArray<string>>([])
      const host = yield* Effect.forkScoped(Stream.runCollect(Stream.take(core.events, 1)), { startImmediately: true })
      yield* core.on(ticked, () => Effect.fail(new Broken({ message: "no room" })), { wait: true, name: "ledger" })
      yield* core.on(ticked, () => Ref.update(ran, (all) => [...all, "later listener"]), { wait: true })
      const failure = yield* Effect.flip(core.publish(tick(1)))
      return { failure, ran: yield* Ref.get(ran), host: yield* Fiber.join(host) }
    }))
    expect(result.failure).toMatchObject({ _tag: "ListenerFailed", listener: "ledger", event: "plugin.clock.ticked", message: "Broken: no room" })
    expect(result.failure.cause).toMatchObject({ _tag: "Broken" })
    expect(result.ran).toEqual([])
    // The stream still shows the event: for a stored one, the journal already holds it.
    expect(result.host.map((event) => event.name)).toEqual([ticked.name])
  })

  test("a waiting listener that dies fails the publish too, as a failure and not a crash", async () => {
    const failure = await run(Effect.gen(function* () {
      const core = yield* makeCore()
      yield* core.on(ticked, () => Effect.die("a bug"), { wait: true, name: "buggy" })
      return yield* Effect.flip(core.publish(tick(1)))
    }))
    expect(failure).toMatchObject({ _tag: "ListenerFailed", listener: "buggy", message: "defect" })
  })

  test("an event whose data is not what a listener's definition describes is that listener's failure", async () => {
    const failure = await run(Effect.gen(function* () {
      const core = yield* makeCore()
      yield* core.on(ticked, () => Effect.void, { wait: true, name: "strict" })
      const wrong: KernelEvent = { _tag: "Live", session: origin.id, turn: origin.turn, name: ticked.name, data: { n: "one" } }
      return yield* Effect.flip(core.publish(wrong))
    }))
    expect(failure).toMatchObject({ _tag: "ListenerFailed", listener: "strict", event: "plugin.clock.ticked" })
  })

  test("skips a waiting listener whose scope closed while the publish was under way", async () => {
    const ran = await run(Effect.gen(function* () {
      const core = yield* makeCore()
      const ran = yield* Ref.make<ReadonlyArray<string>>([])
      const later = yield* Scope.make()
      // The first listener closes the scope the second was registered in, while the same publish is running.
      yield* core.on(ticked, () => Effect.andThen(Ref.update(ran, (all) => [...all, "first"]), Scope.close(later, Exit.void)), { wait: true })
      yield* Effect.provideService(core.on(ticked, () => Ref.update(ran, (all) => [...all, "second, after its scope closed"]), { wait: true }), Scope.Scope, later)
      yield* core.publish(tick(1))
      return yield* Ref.get(ran)
    }))
    expect(ran).toEqual(["first"])
  })
})

describe("a background listener", () => {
  test("that fails is reported as core.listener.failed, and goes on listening", async () => {
    const result = await run(Effect.gen(function* () {
      const core = yield* makeCore()
      const reported = yield* Deferred.make<KernelEvent>()
      const second = yield* Deferred.make<number>()
      yield* core.on(listenerFailedEvent, (event) => Deferred.succeed(reported, event))
      yield* core.on(ticked, (event) => event.data.n === 1 ? Effect.fail(new Broken({ message: "no room" })) : Deferred.succeed(second, event.data.n), { name: "ledger" })
      yield* core.publish(tick(1))
      yield* core.publish(tick(2))
      return { reported: yield* Deferred.await(reported), second: yield* Deferred.await(second) }
    }))
    expect(result.reported).toEqual({ _tag: "Live", session: origin.id, turn: origin.turn, name: listenerFailedEvent.name, data: { listener: "ledger", event: "plugin.clock.ticked", reason: "Broken: no room" } })
    expect(result.second).toBe(2)
  })

  test("that reads slower than events arrive loses the oldest ones: delivery is bounded and sliding", async () => {
    const result = await run(Effect.gen(function* () {
      const core = yield* makeCore({ capacity: 2 })
      const go = yield* Deferred.make<void>()
      const entered = yield* Deferred.make<void>()
      const last = yield* Deferred.make<void>()
      const heard = yield* Ref.make<ReadonlyArray<number>>([])
      yield* core.on(ticked, (event) => Ref.update(heard, (all) => [...all, event.data.n]).pipe(
        Effect.andThen(Deferred.succeed(entered, undefined)),
        Effect.andThen(Deferred.await(go)),
        Effect.andThen(event.data.n === 6 ? Deferred.succeed(last, undefined) : Effect.void),
      ))
      yield* core.publish(tick(1))
      yield* Deferred.await(entered)
      // The listener is busy with the first event while five more arrive; the hub keeps the newest two.
      yield* Effect.forEach([2, 3, 4, 5, 6], (n) => core.publish(tick(n)), { concurrency: 1, discard: true })
      yield* Deferred.succeed(go, undefined)
      yield* Deferred.await(last)
      return yield* Ref.get(heard)
    }))
    expect(result).toEqual([1, 5, 6])
  })
})

describe("core.listener.failed", () => {
  test("is never waited for: a listener registered on it with wait holds neither a publish nor the report of a listener cut short", async () => {
    const result = await run(Effect.gen(function* () {
      const core = yield* makeCore()
      const entered = yield* Deferred.make<void>()
      const reported = yield* Deferred.make<unknown>()
      // A listener of the report that never returns, registered as one to wait for; and a healthy one beside it.
      yield* core.on(listenerFailedEvent, () => Effect.never, { wait: true, name: "hung-reporter" })
      yield* core.on(listenerFailedEvent, (event) => Deferred.succeed(reported, event.data), { wait: true })
      // Publishing the report itself returns: nothing waits for the hung listener.
      yield* core.publish(listenerFailed(tick(0), new ListenerFailed({ listener: "someone", event: ticked.name, message: "said so" })))
      const direct = yield* Deferred.await(reported)
      // And a waiting listener cut short by its publisher's interrupt is reported from a finalizer, which returns too.
      yield* core.on(ticked, () => Effect.andThen(Deferred.succeed(entered, undefined), Effect.never), { wait: true, name: "stuck" })
      const publisher = yield* Effect.forkChild(core.publish(tick(1)))
      yield* Deferred.await(entered)
      const interrupted = yield* Effect.timeoutOption(Fiber.interrupt(publisher), "2 seconds")
      return { direct, interrupted: interrupted._tag }
    }))
    expect(result.direct).toEqual({ listener: "someone", event: "plugin.clock.ticked", reason: "said so" })
    expect(result.interrupted).toBe("Some")
  })

  test("a waiting listener cut short by its publisher's interrupt is reported by name", async () => {
    const result = await run(Effect.gen(function* () {
      const core = yield* makeCore()
      const entered = yield* Deferred.make<void>()
      const reported = yield* Deferred.make<unknown>()
      yield* core.on(listenerFailedEvent, (event) => Deferred.succeed(reported, event.data))
      yield* core.on(ticked, () => Effect.andThen(Deferred.succeed(entered, undefined), Effect.never), { wait: true, name: "stuck" })
      const publisher = yield* Effect.forkChild(core.publish(tick(1)))
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(publisher)
      return yield* Deferred.await(reported)
    }))
    expect(result).toEqual({ listener: "stuck", event: "plugin.clock.ticked", reason: "interrupted before it finished" })
  })

  test("a listener of it that fails is not reported again", async () => {
    const handed = await run(Effect.gen(function* () {
      const core = yield* makeCore()
      const calls = yield* Ref.make(0)
      const second = yield* Deferred.make<void>()
      const all = yield* untilProbe(core)
      // The reporter fails on the first report it hears and says so on the second. It hears them one after another,
      // so when it has heard the second it is done with the first: had that failure been reported, the hub holds it.
      yield* core.on(listenerFailedEvent, () => Effect.flatMap(Ref.updateAndGet(calls, (count) => count + 1), (count) =>
        count === 1 ? Effect.fail(new Broken({ message: "the reporter broke" })) : Effect.asVoid(Deferred.succeed(second, undefined))), { name: "reporter" })
      yield* core.on(ticked, () => Effect.fail(new Broken({ message: "no room" })), { name: "ledger" })
      yield* core.publish(tick(1))
      yield* core.publish(listenerFailed(tick(2), new ListenerFailed({ listener: "someone", event: ticked.name, message: "said so" })))
      yield* Deferred.await(second)
      yield* core.publish(probe)
      return (yield* Fiber.join(all)).map((event): string => event.name)
    }))
    // The ledger's failure and the one published by hand: two reports, and none of the reporter's own failure.
    expect(handed).toEqual(["plugin.clock.ticked", "core.listener.failed", "core.listener.failed", "plugin.clock.tocked"])
  })
})

describe("a listener's registration", () => {
  test("lasts as long as the scope it was made in, waiting or not", async () => {
    const result = await run(Effect.gen(function* () {
      const core = yield* makeCore()
      const heard = yield* Ref.make<ReadonlyArray<string>>([])
      const note = (entry: string) => Ref.update(heard, (all) => [...all, entry])
      const first = yield* Deferred.make<void>()
      const probed = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      yield* Effect.provideService(Effect.andThen(
        core.on(ticked, (event) => note(`waiting ${event.data.n}`), { wait: true }),
        core.on(ticked, (event) => Effect.andThen(note(`background ${event.data.n}`), Deferred.succeed(first, undefined))),
      ), Scope.Scope, scope)
      // A listener that outlives the scope, registered after the two: the hub wakes it after them.
      yield* core.on(tocked, () => Deferred.succeed(probed, undefined))
      yield* core.publish(tick(1))
      yield* Deferred.await(first)
      const during = yield* Ref.get(heard)
      // Closing the scope removes the waiting listener and ends the background one's fiber before it returns.
      yield* Scope.close(scope, Exit.void)
      yield* core.publish(tick(2))
      yield* core.publish(probe)
      yield* Deferred.await(probed)
      return { during, after: yield* Ref.get(heard) }
    }))
    expect(result.during).toEqual(["waiting 1", "background 1"])
    expect(result.after).toEqual(["waiting 1", "background 1"])
  })

  test("is named after the plugin that made it, unless it names itself", async () => {
    const result = await run(Effect.gen(function* () {
      const core = yield* makeCore()
      const failing = definePlugin({
        name: "ledger",
        requires: [Core],
        make: Effect.flatMap(Core, (bus) => bus.on(ticked, () => Effect.fail(new Broken({ message: "no room" })), { wait: true })),
      })
      yield* Layer.build(Layer.provide(failing.layer, Layer.succeed(Core, core)))
      const byPlugin = yield* Effect.flip(core.publish(tick(1)))
      yield* core.on(tocked, () => Effect.fail(new Broken({ message: "no room" })), { wait: true })
      const byHost = yield* Effect.flip(core.publish(live(tocked, origin, { n: 1 })))
      return { byPlugin: byPlugin.listener, byHost: byHost.listener }
    }))
    expect(result).toEqual({ byPlugin: "ledger", byHost: "host" })
  })
})
