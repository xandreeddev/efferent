import { describe, expect, test } from "bun:test"
import { Context, Deferred, Effect, Fiber, Layer, Option, Ref } from "effect"
import { ConversationId, InboxItemId, RunId, SessionLog, SessionLogMemoryLive, Sessions, TurnActivity, TurnAdmissionOpen, UserMessage } from "@xandreed/core"
import type { QueuedInput, SessionAddress } from "@xandreed/core"
import { SessionsLive } from "./sessions.adapter.js"
import { sessionsDefaults } from "./sessions-state.entity.js"

type Log = Context.Service.Shape<typeof SessionLog>
const config = { ...sessionsDefaults, ownership: { mode: "lease" as const, ttlMs: 60_000, renew: "on-commit" as const } }
const completed = { reason: "completed" as const, failure: Option.none() }
const instance = (log: Log) => Layer.build(SessionsLive(config).pipe(
  Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), TurnAdmissionOpen)),
)).pipe(Effect.map((context) => ({ sessions: Context.get(context, Sessions), activity: Context.get(context, TurnActivity) })))
const address = (id: string): SessionAddress => ({ owner: "queued-input-adapter-test", id: ConversationId.make(id) })
const queued = (id: string): QueuedInput => ({ id: InboxItemId.make(id), userMessage: new UserMessage({ text: "Finish the queued work." }), source: {}, delivery: "next" })

describe("queued input admission and concurrent enqueue", () => {
  test("a duplicate that reads a newly committed input refreshes its older head before reporting pending", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const base = Context.get(yield* Layer.build(SessionLogMemoryLive), SessionLog)
    const paused = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const armed = yield* Ref.make(false)
    // One caller retains an empty head while another commits the immutable
    // queue record its subsequent duplicate lookup will see.
    const delayed = SessionLog.of({ ...base, head: (id) => base.head(id).pipe(Effect.tap(() => Ref.getAndSet(armed, false).pipe(
      Effect.flatMap((wait) => wait ? Deferred.succeed(paused, undefined).pipe(Effect.andThen(Deferred.await(release))) : Effect.void),
    ))) })
    const [stale, fresh] = [yield* instance(delayed), yield* instance(base)]
    const session = address("00000000-0000-4000-8000-000000005531")
    yield* stale.sessions.create(session)
    const input = queued("same-input")
    yield* Ref.set(armed, true)
    const waiting = yield* Effect.forkChild(stale.sessions.enqueue(session, input))
    const observed = yield* Effect.gen(function* () {
      yield* Deferred.await(paused)
      const first = yield* fresh.sessions.enqueue(session, input)
      yield* Deferred.succeed(release, undefined)
      return { first, duplicate: yield* Fiber.join(waiting), current: yield* fresh.sessions.get(session), events: yield* fresh.sessions.read(session, { kinds: ["inbox.queued"] }) }
    }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
    expect(observed.first).toEqual({ enqueued: true, pending: 1 })
    expect(observed.duplicate).toEqual({ enqueued: false, pending: 1 })
    expect(observed.current.pending).toBe(1)
    expect(observed.events).toHaveLength(1)
  })).pipe(Effect.timeout("3 seconds"))))

  test("queued input preparation counts as a beginning turn while its queue read waits", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const base = Context.get(yield* Layer.build(SessionLogMemoryLive), SessionLog)
    const paused = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const armed = yield* Ref.make(false)
    const delayed = SessionLog.of({ ...base, read: (id, query) => base.read(id, query).pipe(Effect.tap(() => query.kinds.includes("inbox.queued")
      ? Ref.getAndSet(armed, false).pipe(Effect.flatMap((wait) => wait ? Deferred.succeed(paused, undefined).pipe(Effect.andThen(Deferred.await(release))) : Effect.void))
      : Effect.void)) })
    const { sessions, activity } = yield* instance(delayed)
    const session = address("00000000-0000-4000-8000-000000005532")
    yield* sessions.create(session)
    const input = queued("held-preparation")
    yield* sessions.enqueue(session, input)
    yield* Ref.set(armed, true)
    const beginning = yield* Effect.forkChild(Effect.scoped(sessions.begin(session, { _tag: "Queued", input: input.id, runId: RunId.make("held-preparation-run") }).pipe(
      Effect.flatMap((writer) => writer.end(completed)),
    )))
    const during = yield* Deferred.await(paused).pipe(Effect.andThen(activity.current), Effect.ensuring(Deferred.succeed(release, undefined)))
    yield* Fiber.join(beginning)
    expect(during.beginning).toBe(1)
    expect(during.open).toEqual([])
    expect(yield* activity.current).toEqual({ open: [], beginning: 0 })
    expect((yield* sessions.get(session)).pending).toBe(0)
  })).pipe(Effect.timeout("3 seconds"))))

  test("a direct user key cannot impersonate the same queued message without its input identity", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const log = Context.get(yield* Layer.build(SessionLogMemoryLive), SessionLog)
    const { sessions } = yield* instance(log)
    const session = address("00000000-0000-4000-8000-000000005533")
    yield* sessions.create(session)
    const input = queued("collision")
    const direct = yield* sessions.begin(session, { _tag: "User", key: "input:collision", runId: RunId.make("direct-user"), userMessage: input.userMessage, command: {} })
    yield* direct.end(completed)
    yield* sessions.enqueue(session, input)
    const refusal = yield* Effect.flip(sessions.begin(session, { _tag: "Queued", input: input.id, runId: RunId.make("queued-user") }))
    expect(refusal).toMatchObject({ _tag: "KeyConflict", key: "input:collision", turn: 1 })
    expect((yield* sessions.get(session)).pending).toBe(1)
    expect(yield* sessions.read(session, { kinds: ["turn.started"] })).toHaveLength(1)
    expect(yield* sessions.read(session, { kinds: ["inbox.queued"] })).toHaveLength(1)
  })).pipe(Effect.timeout("3 seconds"))))
})
