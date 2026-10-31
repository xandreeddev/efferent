import { expect, test } from "bun:test"
import { Context, Deferred, Effect, Fiber, Layer, Option, Queue, Ref, Stream } from "effect"
import { ConversationId, harnessError, InboxItemId, SessionLogMemoryLive, Sessions, TurnAdmissionOpen } from "@xandreed/core"
import type { ProcessActivity, ShutdownReport, TurnRunner } from "@xandreed/core"
import { SessionsPluginLive } from "@xandreed/plugin-sessions"
import { ProcessPeer } from "./ports/process-peer.port.js"
import { serveProcess } from "./process-host.adapter.js"
import { ProcessRequestId } from "./process-protocol.entity.js"
import type { ProcessCommand, ProcessEvent } from "./process-protocol.entity.js"

const session = { id: ConversationId.make("10000000-0000-4000-8000-000000000001"), owner: "host" }
const idle: ProcessActivity = { openTurns: [], beginningTurns: 0, runningTasks: 0, waiting: [], queuedInput: 0, inFlight: false, busy: false, stopping: true }
const report: ShutdownReport = { idle: true, interrupted: [], left: idle }
const runner: TurnRunner = { turn: () => Effect.fail(harnessError("turn.failed", "This test does not begin turns.")) }

test.each(["ping", "send"] as const)("shutdown interrupts an accepted cooperative %s worker after core grace", async (kind) => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const commands = yield* Queue.bounded<ProcessCommand>(8)
    const events = yield* Ref.make<ReadonlyArray<ProcessEvent>>([])
    const started = yield* Deferred.make<void>()
    const cleaned = yield* Deferred.make<void>()
    const shutdownEntered = yield* Deferred.make<void>()
    const stopped = yield* Deferred.make<void>()
    const peer = ProcessPeer.of({ commands: Stream.fromQueue(commands), send: (event) => Ref.update(events, (all) => [...all, event]), flush: Effect.void })
    const server = yield* serveProcess({
      owners: ["host"], shutdown: { deadlineMs: 20, reserveMs: 0 }, stop: Deferred.await(stopped),
      setup: () => Effect.gen(function* () {
        const services = yield* Layer.build(SessionsPluginLive().pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen))))
        const sessions = Context.get(services, Sessions)
        const blocked = Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never), Effect.ensuring(Deferred.succeed(cleaned, undefined)))
        return {
          runner, services, use: () => Effect.succeed({ outcome: "completed" as const, reply: Option.none<string>() }),
          sessions: { ...sessions, ...(kind === "send" ? { enqueue: () => blocked } : {}) }, tasks: Option.none(),
          activity: kind === "ping" ? blocked : Effect.succeed(idle),
          shutdown: () => Deferred.succeed(shutdownEntered, undefined).pipe(Effect.as(report)),
        }
      }),
    }).pipe(Effect.provideService(ProcessPeer, peer), Effect.forkScoped)
    yield* Queue.offer(commands, { _tag: "hello", requestId: ProcessRequestId.make("hello"), protocolVersion: 1 })
    yield* Queue.offer(commands, kind === "ping"
      ? { _tag: "ping", requestId: ProcessRequestId.make("blocked") }
      : { _tag: "send", requestId: ProcessRequestId.make("blocked"), session, input: { id: InboxItemId.make("input:1"), userMessage: { text: "Retain this input" }, source: {} } })
    yield* Deferred.await(started)
    yield* Queue.offer(commands, { _tag: "shutdown", requestId: ProcessRequestId.make("shutdown"), deadlineMs: 0 })
    yield* Deferred.await(shutdownEntered)
    const result = yield* Fiber.join(server).pipe(Effect.timeoutOption(500))
    expect(Option.isSome(result)).toBe(true)
    expect(yield* Deferred.isDone(cleaned)).toBe(true)
    expect((yield* Ref.get(events)).some((event) => event._tag === "shutdown")).toBe(true)
    expect((yield* Ref.get(events)).some((event) => event._tag === "pong" || event._tag === "queued")).toBe(false)
  })))
})
