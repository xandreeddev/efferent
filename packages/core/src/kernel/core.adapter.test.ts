import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, Ref, Schema, Scope, Stream } from "effect"
import { makeCore } from "./core.adapter.js"
import { Core } from "./core.port.js"
import { live, liveEvent } from "./event.entity.functions.js"
import type { KernelEvent } from "./event.entity.js"
import { SessionId, TurnNumber } from "./ids.entity.js"
import { definePlugin } from "./plugin.adapter.js"
import { listenerFailedEvent } from "./vocabulary.entity.js"

const origin = { id: SessionId.make("s-1"), turn: TurnNumber.make(1) }
const ticked = liveEvent("clock", "ticked", { data: Schema.Struct({ n: Schema.Int }) })
const tocked = liveEvent("clock", "tocked", { data: Schema.Struct({ n: Schema.Int }) })
const tick = (n: number) => live(ticked, origin, { n })

class Broken extends Schema.TaggedError<Broken>()("Broken", { message: Schema.String }) {}

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect))

/** Wait, without sleeping, until `seen` holds `count` items: background delivery runs on its own fibers. */
const waitFor = <A>(seen: Effect.Effect<ReadonlyArray<A>>, count: number, tries = 5000): Effect.Effect<ReadonlyArray<A>> =>
  Effect.flatMap(seen, (all) => all.length >= count || tries === 0 ? Effect.succeed(all) : Effect.andThen(Effect.yieldNow, Effect.suspend(() => waitFor(seen, count, tries - 1))))

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

  test("hands the event to the background listeners and the host's stream after the waiting ones, without waiting for them", async () => {
    const result = await run(Effect.gen(function* () {
      const core = yield* makeCore()
      const log = yield* Ref.make<ReadonlyArray<string>>([])
      const note = (entry: string) => Ref.update(log, (all) => [...all, entry])
      const host = yield* Effect.forkScoped(Stream.runCollect(Stream.take(core.events, 2)), { startImmediately: true })
      yield* core.on(ticked, (event) => note(`background ${event.data.n}`))
      yield* core.on(ticked, () => Effect.never)
      yield* core.on(ticked, (event) => note(`waiting ${event.data.n}`), { wait: true })
      yield* core.publish(tick(1))
      const atReturn = yield* Ref.get(log)
      yield* waitFor(Ref.get(log), 2)
      yield* core.publish(tick(2))
      const later = yield* waitFor(Ref.get(log), 4)
      return { atReturn, later, host: (yield* Fiber.join(host)).map((event) => event.data) }
    }))
    expect(result.atReturn).toEqual(["waiting 1"])
    expect(result.later).toEqual(["waiting 1", "background 1", "waiting 2", "background 2"])
    expect(result.host).toEqual([{ n: 1 }, { n: 2 }])
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
})

describe("a background listener", () => {
  test("that fails is reported as core.listener.failed, and goes on listening", async () => {
    const result = await run(Effect.gen(function* () {
      const core = yield* makeCore()
      const failures = yield* Ref.make<ReadonlyArray<KernelEvent>>([])
      const heard = yield* Ref.make<ReadonlyArray<number>>([])
      yield* core.on(listenerFailedEvent, (event) => Ref.update(failures, (all) => [...all, event]), { wait: true })
      yield* core.on(ticked, (event) => event.data.n === 1 ? Effect.fail(new Broken({ message: "no room" })) : Ref.update(heard, (all) => [...all, event.data.n]), { name: "ledger" })
      yield* core.publish(tick(1))
      yield* core.publish(tick(2))
      yield* waitFor(Ref.get(heard), 1)
      return { failures: yield* waitFor(Ref.get(failures), 1), heard: yield* Ref.get(heard) }
    }))
    expect(result.failures).toEqual([{ _tag: "Live", session: origin.id, turn: origin.turn, name: listenerFailedEvent.name, data: { listener: "ledger", event: "plugin.clock.ticked", reason: "Broken: no room" } }])
    expect(result.heard).toEqual([2])
  })

  test("of core.listener.failed that fails is not reported again", async () => {
    const reports = await run(Effect.gen(function* () {
      const core = yield* makeCore()
      const reports = yield* Ref.make(0)
      yield* core.on(listenerFailedEvent, () => Effect.andThen(Ref.update(reports, (count) => count + 1), Effect.fail(new Broken({ message: "the reporter broke" }))), { wait: true, name: "reporter" })
      yield* core.on(listenerFailedEvent, () => Effect.fail(new Broken({ message: "and so did this one" })), { name: "background-reporter" })
      yield* core.on(ticked, () => Effect.fail(new Broken({ message: "no room" })), { name: "ledger" })
      yield* core.publish(tick(1))
      yield* waitFor(Effect.map(Ref.get(reports), (count) => Array.from({ length: count })), 1)
      // Were a reporter's failure reported, the count would keep growing.
      yield* waitFor(Effect.succeed([]), 1, 300)
      return yield* Ref.get(reports)
    }))
    expect(reports).toBe(1)
  })

  test("that reads slower than events arrive loses the oldest ones: delivery is bounded and sliding", async () => {
    const result = await run(Effect.gen(function* () {
      const core = yield* makeCore({ capacity: 2 })
      const go = yield* Deferred.make<void>()
      const entered = yield* Deferred.make<void>()
      const heard = yield* Ref.make<ReadonlyArray<number>>([])
      yield* core.on(ticked, (event) => Effect.andThen(Ref.update(heard, (all) => [...all, event.data.n]), Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(go))))
      yield* core.publish(tick(1))
      yield* Deferred.await(entered)
      // The listener is busy with the first event while five more arrive; the hub keeps the newest two.
      yield* Effect.forEach([2, 3, 4, 5, 6], (n) => core.publish(tick(n)), { concurrency: 1, discard: true })
      yield* Deferred.succeed(go, undefined)
      return yield* waitFor(Ref.get(heard), 3)
    }))
    expect(result).toEqual([1, 5, 6])
  })
})

describe("a listener's registration", () => {
  test("lasts as long as the scope it was made in, waiting or not", async () => {
    const result = await run(Effect.gen(function* () {
      const core = yield* makeCore()
      const heard = yield* Ref.make<ReadonlyArray<string>>([])
      const note = (entry: string) => Ref.update(heard, (all) => [...all, entry])
      const scope = yield* Scope.make()
      yield* Effect.provideService(Effect.andThen(
        core.on(ticked, (event) => note(`waiting ${event.data.n}`), { wait: true }),
        core.on(ticked, (event) => note(`background ${event.data.n}`)),
      ), Scope.Scope, scope)
      yield* core.publish(tick(1))
      const during = yield* waitFor(Ref.get(heard), 2)
      yield* Scope.close(scope, Exit.void)
      yield* core.publish(tick(2))
      yield* waitFor(Effect.succeed([]), 1, 300)
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

  test("a waiting listener cut short by its publisher's interrupt is reported by name", async () => {
    const result = await run(Effect.gen(function* () {
      const core = yield* makeCore()
      const entered = yield* Deferred.make<void>()
      const failures = yield* Ref.make<ReadonlyArray<unknown>>([])
      yield* core.on(listenerFailedEvent, (event) => Ref.update(failures, (all) => [...all, event.data]), { wait: true })
      yield* core.on(ticked, () => Effect.andThen(Deferred.succeed(entered, undefined), Effect.never), { wait: true, name: "stuck" })
      const publisher = yield* Effect.forkChild(core.publish(tick(1)))
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(publisher)
      return yield* Ref.get(failures)
    }))
    expect(result).toEqual([{ listener: "stuck", event: "plugin.clock.ticked", reason: "interrupted before it finished" }])
  })
})
