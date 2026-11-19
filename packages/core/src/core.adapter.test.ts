import { describe, expect, test } from "bun:test"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Option, Ref, Schema, Scope, Stream } from "effect"
import { kernel, makeCore } from "./core.adapter.js"
import { Core } from "./core.port.js"
import { announced, live, liveEvent, stored, storedEvent } from "./event.entity.functions.js"
import type { KernelEvent } from "./event.entity.js"
import { Seq, SessionId, TurnNumber } from "./ids.entity.js"
import { listenerFailed } from "./vocabulary.entity.functions.js"
import { listenerFailedEvent } from "./vocabulary.entity.js"
import { ListenerFailed } from "./event.entity.js"

const origin = { id: SessionId.make("s-1"), turn: TurnNumber.make(1) }
const ticked = liveEvent("clock", "ticked", { tags: ["trace"], data: Schema.Struct({ n: Schema.Int }) })
const tocked = liveEvent("clock", "tocked", { tags: ["trace"], data: Schema.Struct({ n: Schema.Int }) })
const tick = (n: number) => live(ticked, origin, { n })
/** An event no listener waits for: published after something, it marks "everything before this has been handed over". */
const probe = live(tocked, origin, { n: 0 })

class Broken extends Schema.TaggedError<Broken>()("Broken", { message: Schema.String }) {}

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect))

/** Everything the hub hands over, in its order, up to and including the probe; reading from now. */
const untilProbe = (core: Effect.Success<ReturnType<typeof makeCore>>) =>
  Effect.forkScoped(Stream.runCollect(Stream.takeUntil(core.events, (event) => event.name === tocked.name)), { startImmediately: true })

describe("Core.on", () => {
  const noted = storedEvent("notes", "noted", { tags: ["trace"], data: Schema.Struct({ text: Schema.String }), skippable: true })
  /** A live definition under the same name as the stored one: what a careless publisher could make. */
  const impostor = { ...liveEvent("notes", "noted", { tags: ["trace"], data: Schema.Struct({ text: Schema.String }) }) }
  const record = (seq: number, text: string) => announced(origin, { seq: Seq.make(seq), at: 0, turn: origin.turn, ...stored(noted, { text }, { message: { _tag: "User", text } }) })

  test("hands a stored definition's listener the record, and a live one's the live event: neither is told apart by hand", async () => {
    const heard = await run(Effect.gen(function* () {
      const core = yield* makeCore()
      const heard = yield* Ref.make<ReadonlyArray<string>>([])
      // The handler reads the record's place and the message it bears, and a live event's turn, with no check of which it was given.
      yield* core.on(noted, (event) => Ref.update(heard, (all) => [...all, `record ${event.seq} ${event.data.text} ${event.message?._tag ?? "no message"}`]), { wait: true, name: "host" })
      yield* core.on(ticked, (event) => Ref.update(heard, (all) => [...all, `live ${event.data.n} turn ${event.turn ?? "none"}`]), { wait: true, name: "host" })
      yield* core.publish(record(4, "kept"))
      yield* core.publish(tick(7))
      return yield* Ref.get(heard)
    }))
    expect(heard).toEqual(["record 4 kept User", "live 7 turn 1"])
  })

  test("delivers an event to a listener only when it is of the definition's kind as well as its name", async () => {
    const heard = await run(Effect.gen(function* () {
      const core = yield* makeCore()
      const heard = yield* Ref.make<ReadonlyArray<string>>([])
      const reached = yield* Deferred.make<void>()
      yield* core.on(noted, (event) => Ref.update(heard, (all) => [...all, `waiting ${event.seq}`]), { wait: true, name: "host" })
      yield* core.on(noted, (event) => Effect.andThen(Ref.update(heard, (all) => [...all, `background ${event.seq}`]), Deferred.succeed(reached, undefined)), { name: "host" })
      // A live event under the record's name is no record: a handler written for records is not given it, waiting or not.
      // It is published first, so a background listener that took it would have it before the record.
      yield* core.publish(live(impostor, origin, { text: "not stored" }))
      yield* core.publish(record(2, "stored"))
      yield* Deferred.await(reached)
      return yield* Ref.get(heard)
    }))
    expect(heard).toEqual(["waiting 2", "background 2"])
  })
})

describe("Core.publish", () => {
  test("runs the waiting listeners in the order they registered, one after another, before it returns", async () => {
    const log = await run(Effect.gen(function* () {
      const core = yield* makeCore()
      const log = yield* Ref.make<ReadonlyArray<string>>([])
      const note = (entry: string) => Ref.update(log, (all) => [...all, entry])
      yield* core.on(ticked, (event) => Effect.andThen(note(`first ${event.data.n} in`), Effect.andThen(Effect.yieldNow, note(`first ${event.data.n} out`))), { wait: true, name: "host" })
      yield* core.on(tocked, () => note("not for this event"), { wait: true, name: "host" })
      yield* core.on(ticked, (event) => note(`second ${event.data.n}`), { wait: true, name: "host" })
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
      yield* core.on(ticked, () => Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(go)), { wait: true, name: "host" })
      const publisher = yield* Effect.forkChild(core.publish(tick(1)))
      yield* Deferred.await(entered)
      // The waiting listener holds the first event. An event published now reaches the hub before it: were the
      // hub handed an event before its waiting listeners ran, the tick would be there first.
      yield* core.publish(live(liveEvent("clock", "chimed", { tags: ["trace"], data: Schema.Struct({}) }), origin, {}))
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
      yield* core.on(ticked, () => Effect.never, { name: "host" })
      yield* core.on(ticked, (event) => Deferred.succeed(heard, event.data.n), { name: "host" })
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
      yield* core.on(ticked, () => Ref.update(ran, (all) => [...all, "later listener"]), { wait: true, name: "host" })
      const failure = yield* Effect.flip(core.publish(tick(1)))
      return { failure, ran: yield* Ref.get(ran), host: yield* Fiber.join(host) }
    }))
    expect(result.failure).toMatchObject({ _tag: "ListenerFailed", listener: "ledger", event: "plugin.clock.ticked", message: "Broken: no room" })
    expect(result.failure.cause).toMatchObject({ _tag: "Broken" })
    expect(result.ran).toEqual([])
    // The stream still shows the event: for a stored one, the journal already holds it.
    expect(result.host.map((event) => event.name)).toEqual([ticked.name])
  })

  test("told to report listener failures, runs every waiting listener, and reports each failure once the event was handed over, without failing", async () => {
    const result = await run(Effect.gen(function* () {
      const core = yield* makeCore()
      const ran = yield* Ref.make<ReadonlyArray<string>>([])
      const handed = yield* untilProbe(core)
      yield* core.on(ticked, () => Effect.fail(new Broken({ message: "no room" })), { wait: true, name: "ledger" })
      yield* core.on(ticked, () => Ref.update(ran, (all) => [...all, "between"]), { wait: true, name: "host" })
      yield* core.on(ticked, () => Effect.die("a bug"), { wait: true, name: "buggy" })
      yield* core.on(ticked, () => Ref.update(ran, (all) => [...all, "last"]), { wait: true, name: "host" })
      const exit = yield* Effect.exit(core.publish(tick(1), { listenerFailures: "report" }))
      yield* core.publish(probe)
      const events = yield* Fiber.join(handed)
      return {
        exit: exit._tag,
        ran: yield* Ref.get(ran),
        handed: events.map((event) => event.name === listenerFailedEvent.name ? `${event.name} ${JSON.stringify(event.data)}` : event.name),
      }
    }))
    expect(result.exit).toBe("Success")
    expect(result.ran).toEqual(["between", "last"])
    // The event first, as the default hands it over; then one report per failure, in the order the listeners ran.
    expect(result.handed).toEqual([
      ticked.name,
      `${listenerFailedEvent.name} {"listener":"ledger","event":"${ticked.name}","reason":"Broken: no room"}`,
      `${listenerFailedEvent.name} {"listener":"buggy","event":"${ticked.name}","reason":"defect"}`,
      tocked.name,
    ])
  })

  test("a waiting listener that dies fails the publish too, as a failure and not a crash", async () => {
    const failure = await run(Effect.gen(function* () {
      const core = yield* makeCore()
      yield* core.on(ticked, () => Effect.die("a bug"), { wait: true, name: "buggy" })
      return yield* Effect.flip(core.publish(tick(1)))
    }))
    expect(failure).toMatchObject({ _tag: "ListenerFailed", listener: "buggy", message: "defect" })
  })

  test("a waiting listener that ends with an interrupt it was not sent fails the publish with ListenerFailed, not an interrupt", async () => {
    const result = await run(Effect.gen(function* () {
      const core = yield* makeCore()
      const reported = yield* Ref.make<ReadonlyArray<unknown>>([])
      yield* core.on(listenerFailedEvent, (event) => Ref.update(reported, (all) => [...all, event.data]), { wait: true, name: "host" })
      // Joining a fiber that was interrupted ends the handler with an interrupt it was not sent.
      yield* core.on(ticked, () => Effect.flatMap(Effect.forkChild(Effect.never), (fiber) => Effect.andThen(Fiber.interrupt(fiber), Fiber.join(fiber))), { wait: true, name: "joiner" })
      const exit = yield* Effect.exit(core.publish(tick(1)))
      yield* core.publish(probe)
      return { exit, reported: yield* Ref.get(reported) }
    }).pipe(Effect.timeout("2 seconds")))
    expect(Exit.hasInterrupts(result.exit)).toBe(false)
    expect(Exit.isFailure(result.exit) ? Cause.squash(result.exit.cause) : result.exit).toMatchObject({ _tag: "ListenerFailed", listener: "joiner", event: "plugin.clock.ticked", message: "interrupted" })
    // Nothing reports the listener as cut short: its publisher was never interrupted.
    expect(result.reported).toEqual([])
  })

  test("a waiting listener that does not suspend runs before any other fiber, as if it were called in place", async () => {
    const order = await run(Effect.gen(function* () {
      const core = yield* makeCore()
      const order = yield* Ref.make<ReadonlyArray<string>>([])
      const note = (line: string) => Ref.update(order, (all) => [...all, line])
      yield* core.on(ticked, () => note("the listener"), { wait: true, name: "host" })
      // A fiber ready to run before the publish begins.
      const other = yield* Effect.forkChild(note("another fiber"))
      yield* core.publish(tick(1))
      yield* Fiber.join(other)
      return yield* Ref.get(order)
    }))
    expect(order).toEqual(["the listener", "another fiber"])
  })

  test("an event whose data is not what a listener's definition describes is that listener's failure", async () => {
    const failure = await run(Effect.gen(function* () {
      const core = yield* makeCore()
      yield* core.on(ticked, () => Effect.void, { wait: true, name: "strict" })
      const wrong: KernelEvent = { _tag: "Live", session: origin.id, turn: origin.turn, name: ticked.name, tags: ticked.tags, data: { n: "one" } }
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
      yield* core.on(ticked, () => Effect.andThen(Ref.update(ran, (all) => [...all, "first"]), Scope.close(later, Exit.void)), { wait: true, name: "host" })
      yield* Effect.provideService(core.on(ticked, () => Ref.update(ran, (all) => [...all, "second, after its scope closed"]), { wait: true, name: "host" }), Scope.Scope, later)
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
      yield* core.on(listenerFailedEvent, (event) => Deferred.succeed(reported, event), { name: "host" })
      yield* core.on(ticked, (event) => event.data.n === 1 ? Effect.fail(new Broken({ message: "no room" })) : Deferred.succeed(second, event.data.n), { name: "ledger" })
      yield* core.publish(tick(1))
      yield* core.publish(tick(2))
      return { reported: yield* Deferred.await(reported), second: yield* Deferred.await(second) }
    }))
    expect(result.reported).toEqual({ _tag: "Live", session: origin.id, turn: origin.turn, name: listenerFailedEvent.name, tags: listenerFailedEvent.tags, data: { listener: "ledger", event: "plugin.clock.ticked", reason: "Broken: no room" } })
    expect(result.second).toBe(2)
  })

  test("that ends with an interrupt it was not sent is reported as core.listener.failed, and goes on listening", async () => {
    const result = await run(Effect.gen(function* () {
      const core = yield* makeCore()
      const reported = yield* Deferred.make<KernelEvent>()
      const heard = yield* Ref.make<ReadonlyArray<number>>([])
      const third = yield* Deferred.make<void>()
      yield* core.on(listenerFailedEvent, (event) => Deferred.succeed(reported, event), { name: "host" })
      // On the first event the handler interrupts itself; nobody interrupted the one who waits for it.
      yield* core.on(ticked, (event) => event.data.n === 1
        ? Effect.interrupt
        : Effect.andThen(Ref.update(heard, (all) => [...all, event.data.n]), event.data.n === 3 ? Deferred.succeed(third, undefined) : Effect.void), { name: "ledger" })
      yield* Effect.forEach([1, 2, 3], (n) => core.publish(tick(n)), { concurrency: 1, discard: true })
      yield* Deferred.await(third)
      return { reported: yield* Deferred.await(reported), heard: yield* Ref.get(heard) }
    }).pipe(Effect.timeout("2 seconds")))
    expect(result.heard).toEqual([2, 3])
    expect(result.reported).toEqual({ _tag: "Live", session: origin.id, turn: origin.turn, name: listenerFailedEvent.name, tags: listenerFailedEvent.tags, data: { listener: "ledger", event: "plugin.clock.ticked", reason: "interrupted" } })
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
      ), { name: "host" })
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
      yield* core.on(listenerFailedEvent, (event) => Deferred.succeed(reported, event.data), { wait: true, name: "host" })
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
      yield* core.on(listenerFailedEvent, (event) => Deferred.succeed(reported, event.data), { name: "host" })
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
        core.on(ticked, (event) => note(`waiting ${event.data.n}`), { wait: true, name: "host" }),
        core.on(ticked, (event) => Effect.andThen(note(`background ${event.data.n}`), Deferred.succeed(first, undefined)), { name: "host" }),
      ), Scope.Scope, scope)
      // A listener that outlives the scope, registered after the two: the hub wakes it after them.
      yield* core.on(tocked, () => Deferred.succeed(probed, undefined), { name: "host" })
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

  test("is reported under the name it was registered with", async () => {
    const result = await run(Effect.gen(function* () {
      const core = yield* makeCore()
      yield* core.on(ticked, () => Effect.fail(new Broken({ message: "no room" })), { wait: true, name: "ledger" })
      return (yield* Effect.flip(core.publish(tick(1)))).listener
    }))
    expect(result).toBe("ledger")
  })
})

describe("kernel", () => {
  test("provides Core and nothing else, and its events end with its scope", async () => {
    const result = await run(Effect.gen(function* () {
      const built = yield* Layer.build(kernel({ capacity: 4 }))
      const core = Context.get(built, Core)
      const heard = yield* Deferred.make<number>()
      yield* core.on(ticked, (event) => Deferred.succeed(heard, event.data.n), { name: "host" })
      yield* core.publish(tick(7))
      return { keys: Array.from(built.mapUnsafe.keys()).filter((key) => !key.startsWith("effect/")), heard: yield* Deferred.await(heard) }
    }).pipe(Effect.timeout("2 seconds")))
    expect(result).toEqual({ keys: ["@xandreed/core/kernel/Core"], heard: 7 })
  })
})

/*
 * No limit on a wait for a listener depends on the listener: a publisher
 * whose limit ran out, and a scope that closes, return at their own time
 * over a listener that cannot be interrupted. Each of these gives itself
 * two seconds, so code that waits on the listener fails here and does not
 * hang the run.
 */
describe("a listener that cannot be interrupted", () => {
  const deaf = Effect.uninterruptible(Effect.never)

  test("does not hold a publish past the limit put on it: the publish returns at its limit, and the listener is reported", async () => {
    const result = await run(Effect.gen(function* () {
      const core = yield* makeCore()
      const entered = yield* Deferred.make<void>()
      const reported = yield* Deferred.make<unknown>()
      yield* core.on(listenerFailedEvent, (event) => Deferred.succeed(reported, event.data), { name: "host" })
      yield* core.on(ticked, () => Effect.andThen(Deferred.succeed(entered, undefined), deaf), { wait: true, name: "deaf" })
      const handed = yield* untilProbe(core)
      const limited = yield* core.publish(tick(1)).pipe(Effect.timeoutOption("20 millis"))
      yield* Deferred.await(entered)
      const report = yield* Deferred.await(reported)
      // The publisher is free: the next event goes through, and the one it gave up on was handed over all the same.
      yield* core.publish(probe)
      return { limited: Option.isNone(limited), report, handed: (yield* Fiber.join(handed)).map((event): string => event.name) }
    }).pipe(Effect.timeout("2 seconds")))
    expect(result.limited).toBe(true)
    expect(result.report).toEqual({ listener: "deaf", event: "plugin.clock.ticked", reason: "interrupted before it finished" })
    expect(result.handed).toEqual(["core.listener.failed", "plugin.clock.ticked", "plugin.clock.tocked"])
  })

  test("does not hold its publisher's interrupt", async () => {
    const result = await run(Effect.gen(function* () {
      const core = yield* makeCore()
      const entered = yield* Deferred.make<void>()
      yield* core.on(ticked, () => Effect.andThen(Deferred.succeed(entered, undefined), deaf), { wait: true, name: "host" })
      const publisher = yield* Effect.forkChild(core.publish(tick(1)))
      yield* Deferred.await(entered)
      return (yield* Fiber.interrupt(publisher).pipe(Effect.as("returned")))
    }).pipe(Effect.timeout("2 seconds")))
    expect(result).toBe("returned")
  })

  test("does not hold the close of its scope, in the background", async () => {
    const result = await run(Effect.gen(function* () {
      const core = yield* makeCore()
      const scope = yield* Scope.make()
      const entered = yield* Deferred.make<void>()
      yield* core.on(ticked, () => Effect.andThen(Deferred.succeed(entered, undefined), deaf), { name: "host" }).pipe(Scope.provide(scope))
      yield* core.publish(tick(1))
      yield* Deferred.await(entered)
      yield* Scope.close(scope, Exit.void)
      // The bus goes on without it.
      const heard = yield* Deferred.make<number>()
      yield* core.on(ticked, (event) => Deferred.succeed(heard, event.data.n), { name: "host" })
      yield* core.publish(tick(2))
      return yield* Deferred.await(heard)
    }).pipe(Effect.timeout("2 seconds")))
    expect(result).toBe(2)
  })

  test("does not hold the close of the scope of the one who waits for it", async () => {
    const result = await run(Effect.gen(function* () {
      const core = yield* makeCore()
      const scope = yield* Scope.make()
      const entered = yield* Deferred.make<void>()
      const reported = yield* Deferred.make<unknown>()
      yield* core.on(listenerFailedEvent, (event) => Deferred.succeed(reported, event.data), { name: "host" })
      // Registered and waited for in the same scope: the publish is a fiber of that scope, held by the listener.
      yield* core.on(ticked, () => Effect.andThen(Deferred.succeed(entered, undefined), deaf), { wait: true, name: "deaf" }).pipe(Scope.provide(scope))
      yield* Effect.forkIn(core.publish(tick(1)), scope)
      yield* Deferred.await(entered)
      yield* Scope.close(scope, Exit.void)
      const report = yield* Deferred.await(reported)
      // The bus goes on without it: the waiting listener left with its scope.
      const heard = yield* Deferred.make<number>()
      yield* core.on(ticked, (event) => Deferred.succeed(heard, event.data.n), { wait: true, name: "host" })
      yield* core.publish(tick(2))
      return { report, heard: yield* Deferred.await(heard) }
    }).pipe(Effect.timeout("2 seconds")))
    expect(result).toEqual({ report: { listener: "deaf", event: "plugin.clock.ticked", reason: "interrupted before it finished" }, heard: 2 })
  })
})

describe("a listener that is cut short", () => {
  test("is interrupted behind the one who stopped waiting: by a limit on the publish, and by the close of its scope", async () => {
    const result = await run(Effect.gen(function* () {
      const core = yield* makeCore()
      const scope = yield* Scope.make()
      const entered = { waited: yield* Deferred.make<void>(), background: yield* Deferred.make<void>() }
      const stopped = { waited: yield* Deferred.make<string>(), background: yield* Deferred.make<string>() }
      // Each runs until it is interrupted, and says so when it is.
      const until = (which: "waited" | "background") => Deferred.succeed(entered[which], undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(stopped[which], `${which} interrupted`)),
      )
      yield* core.on(ticked, () => until("waited"), { wait: true, name: "host" })
      yield* core.on(tocked, () => until("background"), { name: "host" }).pipe(Scope.provide(scope))
      const limited = yield* core.publish(tick(1)).pipe(Effect.timeoutOption("20 millis"))
      yield* core.publish(probe)
      yield* Deferred.await(entered.background)
      yield* Scope.close(scope, Exit.void)
      return { limited: Option.isNone(limited), stopped: [yield* Deferred.await(stopped.waited), yield* Deferred.await(stopped.background)] }
    }).pipe(Effect.timeout("2 seconds")))
    expect(result.limited).toBe(true)
    expect(result.stopped).toEqual(["waited interrupted", "background interrupted"])
  })
})

describe("the publisher's own step, beforeHandOver", () => {
  /** A bus with a waiting listener, a background one and the stream, each writing down when it saw the event. */
  const ordered = (waited: Effect.Effect<void, Broken>) => Effect.gen(function* () {
    const core = yield* makeCore()
    const order = yield* Ref.make<ReadonlyArray<string>>([])
    const note = (line: string) => Ref.update(order, (all) => [...all, line])
    const heard = yield* Deferred.make<void>()
    yield* core.on(ticked, () => Effect.andThen(note("the waiting listener"), waited), { wait: true, name: "host" })
    yield* core.on(ticked, () => Effect.andThen(note("the background listener"), Deferred.succeed(heard, undefined)), { name: "host" })
    yield* Effect.forkScoped(Stream.runForEach(Stream.filter(core.events, (event) => event.name === ticked.name), () => note("the stream")), { startImmediately: true })
    return { core, note, order: Effect.andThen(Deferred.await(heard), Ref.get(order)) }
  })

  test("runs after the waiting listeners and before the event is handed to the background listeners and the stream", async () => {
    const order = await run(Effect.gen(function* () {
      const bus = yield* ordered(Effect.void)
      yield* bus.core.publish(tick(1), { beforeHandOver: bus.note("the publisher's step") })
      yield* bus.note("the publish returned")
      return yield* bus.order
    }).pipe(Effect.timeout("2 seconds")))
    expect(order.slice(0, 2)).toEqual(["the waiting listener", "the publisher's step"])
    // The background and the stream have it only after the step, in whatever order between them.
    expect(order.indexOf("the publisher's step")).toBeLessThan(order.indexOf("the background listener"))
    expect(order.indexOf("the publisher's step")).toBeLessThan(order.indexOf("the stream"))
  })

  test("runs whatever the waiting listeners did: when one fails, and when the publish is cut by a limit, still before the hand-over", async () => {
    const result = await run(Effect.gen(function* () {
      const failing = yield* ordered(Effect.fail(new Broken({ message: "no" })))
      const failed = yield* Effect.flip(failing.core.publish(tick(1), { beforeHandOver: failing.note("the publisher's step") }))
      const hanging = yield* ordered(Effect.uninterruptible(Effect.never))
      const limited = yield* hanging.core.publish(tick(1), { beforeHandOver: hanging.note("the publisher's step") }).pipe(Effect.timeoutOption("20 millis"))
      return { failed: failed._tag, limited: Option.isNone(limited), whenFailed: yield* failing.order, whenCut: yield* hanging.order }
    }).pipe(Effect.timeout("2 seconds")))
    expect(result.failed).toBe("ListenerFailed")
    expect(result.limited).toBe(true)
    for (const order of [result.whenFailed, result.whenCut]) {
      expect(order.slice(0, 2)).toEqual(["the waiting listener", "the publisher's step"])
      expect(order).toContain("the background listener")
    }
  })
})
