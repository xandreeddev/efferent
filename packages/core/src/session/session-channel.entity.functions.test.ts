import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Logger, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
import { ConversationId } from "../domain/message.entity.js"
import { InvocationId, RunOrdinal } from "../domain/run.entity.js"
import { SessionChannel } from "../ports/session-channel.port.js"
import { makeTurnEvents } from "../turn/turn-bus.adapter.js"
import { StreamPartId } from "../turn/turn-event.entity.js"
import type { TurnEvent } from "../turn/turn-event.entity.js"
import { SessionChannelError } from "./session-channel.entity.js"
import type { SessionChannelPayload } from "./session-channel.entity.js"
import { shareTransient } from "./session-channel.entity.functions.js"
import type { ShareTransientOptions } from "./session-channel.entity.functions.js"
import type { SessionAddress } from "./sessions.entity.js"

const address: SessionAddress = { id: ConversationId.make("00000000-0000-4000-8000-0000000000c1"), owner: "owner-1" }
const delta = (text: string): TurnEvent => ({ _tag: "assistant.delta", step: 1, channel: "text", id: StreamPartId.make("t"), delta: text })
const progress: TurnEvent = { _tag: "tool.progress", step: 1, invocationId: InvocationId.make("i1"), tool: "bash", channel: "stdout", text: "ok\n" }
const started: TurnEvent = { _tag: "step.started", step: 1, run: RunOrdinal.make(0), planned: false, activeTools: [] }
const host: TurnEvent = { _tag: "host", name: "app.progress", data: { done: 1 } }

/** The messages logged while `effect` runs. */
const logging = (logged: Array<string>) => Logger.layer([Logger.make((options) => { logged.push(String(options.message)) })])

/** What a turn's bus shares, once the subscription's scope has closed, through a channel that records each publish (or fails each one). */
const sharedBy = (events: ReadonlyArray<TurnEvent>, options?: ShareTransientOptions, failing = false, logged: Array<string> = []) => Effect.runPromise(Effect.gen(function* () {
  const published = yield* Ref.make<ReadonlyArray<readonly [SessionAddress, SessionChannelPayload]>>([])
  const channel = SessionChannel.of({
    publish: (to, payload) => failing
      ? Effect.fail(new SessionChannelError({ reason: "unavailable", message: "the broker is down" }))
      : Ref.update(published, (all) => [...all, [to, payload] as const]),
    subscribe: () => Stream.empty,
  })
  yield* Effect.scoped(Effect.gen(function* () {
    const bus = yield* makeTurnEvents({ maxDepth: 4 })
    yield* shareTransient(address, options)(bus).pipe(Effect.provideService(SessionChannel, channel))
    yield* Effect.forEach(events, bus.publish, { concurrency: 1, discard: true })
    yield* bus.drain
  }))
  return yield* Ref.get(published)
}).pipe(Effect.provide(logging(logged))))

describe("shareTransient", () => {
  test("sends each transient event to the session's channel, named as the event, its other fields as data", async () => {
    const published = await sharedBy([started, delta("Hel"), host, progress, delta("lo")])
    expect(published.map(([to]) => to)).toEqual([address, address, address])
    expect(published.map(([, payload]) => payload)).toEqual([
      { event: "assistant.delta", data: { step: 1, channel: "text", id: "t", delta: "Hel" } },
      { event: "tool.progress", data: { step: 1, invocationId: "i1", tool: "bash", channel: "stdout", text: "ok\n" } },
      { event: "assistant.delta", data: { step: 1, channel: "text", id: "t", delta: "lo" } },
    ])
  })

  test("sends only the transient events it is given", async () => {
    const progressOnly = await sharedBy([delta("a"), progress], { events: ["tool.progress"] })
    const deltasOnly = await sharedBy([delta("a"), progress, delta("b")], { events: ["assistant.delta"] })
    expect(progressOnly.map(([, payload]) => payload.event)).toEqual(["tool.progress"])
    expect(deltasOnly.map(([, payload]) => payload.data.delta)).toEqual(["a", "b"])
  })

  test("a full queue drops the oldest waiting payload, never the turn's publish", async () => {
    const published = await Effect.runPromise(Effect.gen(function* () {
      const sent = yield* Ref.make<ReadonlyArray<string>>([])
      const gate = yield* Deferred.make<void>()
      // The first publish waits until every delta is published to the bus: those after it queue up.
      const channel = SessionChannel.of({
        publish: (_, payload) => Deferred.await(gate).pipe(Effect.andThen(Ref.update(sent, (all) => [...all, String(payload.data.delta)]))),
        subscribe: () => Stream.empty,
      })
      yield* Effect.scoped(Effect.gen(function* () {
        const bus = yield* makeTurnEvents({ maxDepth: 4 })
        yield* shareTransient(address, { capacity: 2 })(bus).pipe(Effect.provideService(SessionChannel, channel))
        yield* bus.publish(delta("a"))
        yield* Effect.yieldNow
        yield* Effect.forEach(["b", "c", "d"], (text) => bus.publish(delta(text)), { concurrency: 1, discard: true })
        yield* Deferred.succeed(gate, undefined)
      }))
      return yield* Ref.get(sent)
    }))
    expect(published).toEqual(["a", "c", "d"])
  })

  test("a channel whose publish never completes holds neither the bus nor the scope's close: each payload is dropped after the timeout", async () => {
    const logged: Array<string> = []
    const observed = await Effect.runPromise(Effect.gen(function* () {
      const asked = yield* Ref.make(0)
      const hung = SessionChannel.of({ publish: () => Ref.update(asked, (n) => n + 1).pipe(Effect.andThen(Effect.never)), subscribe: () => Stream.empty })
      const closing = yield* Effect.forkChild(Effect.scoped(Effect.gen(function* () {
        const bus = yield* makeTurnEvents({ maxDepth: 4 })
        yield* shareTransient(address, { publishTimeoutMs: 50 })(bus).pipe(Effect.provideService(SessionChannel, hung))
        yield* Effect.forEach([delta("a"), progress, delta("b")], bus.publish, { concurrency: 1, discard: true })
        yield* bus.drain
        // The first publish times out and is dropped while the turn goes on.
        yield* TestClock.adjust(50)
        return "published"
      })))
      // The scope's close waits one more timeout for what is still waiting, then drops it.
      yield* TestClock.adjust(50)
      yield* TestClock.adjust(50)
      return { closed: yield* Fiber.join(closing), asked: yield* Ref.get(asked) }
    }).pipe(Effect.provide(Layer.merge(TestClock.layer(), logging(logged)))))
    expect(observed.closed).toBe("published")
    expect(observed.asked).toBeGreaterThanOrEqual(2)
    expect(logged.some((message) => message.includes("did not take it within"))).toBe(true)
  })

  test("a channel that fails a publish never fails the turn's bus: the event is logged and dropped", async () => {
    const logged: Array<string> = []
    expect(await sharedBy([delta("a"), progress], {}, true, logged)).toEqual([])
    expect(logged.filter((message) => message.includes("not shared with the session's followers"))).toHaveLength(2)
  })
})
