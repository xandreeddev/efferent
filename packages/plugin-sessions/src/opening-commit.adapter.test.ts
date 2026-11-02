import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Option, Ref, Scope } from "effect"
import { TestClock } from "effect/testing"
import { RunId, SessionLog, SessionLogError, SessionLogMemoryLive, Sessions, TurnAdmissionOpen, UserMessage } from "@xandreed/core"
import type { BeginTurn, SessionAddress } from "@xandreed/core"
import { SessionsLive } from "./sessions.adapter.js"
import { sessionsDefaults } from "./sessions-state.entity.js"
import type { SessionsConfig } from "./sessions-state.entity.js"

/*
 * A begin whose opening commit fails with a store error: the store may have
 * stored it all the same (a write that stalled and landed later). The turn
 * it would open is let go of, by its number and run, so the next begin on
 * the instance reaps it if it is there, and never a turn opened since under
 * that number.
 */

type Log = Context.Service.Shape<typeof SessionLog>
const owner = "owner-opening"
const say = (key: string, runId = `run-${key}`): BeginTurn => ({ _tag: "User", userMessage: new UserMessage({ text: key }), runId: RunId.make(runId), key, command: {} })
const processMode: SessionsConfig = { ...sessionsDefaults, ownership: { mode: "process" } }

/** The memory log, with its next opening commit (one storing `turn.started`) failing after it stored it (`landed`) or before. */
const failingOnce = Effect.gen(function* () {
  const inner = Context.get(yield* Layer.build(SessionLogMemoryLive), SessionLog)
  const armed = yield* Ref.make<Option.Option<"landed" | "lost">>(Option.none())
  const stalled = new SessionLogError({ code: "store.stalled", message: "the store did not answer; the write may still land" })
  const log: Log = SessionLog.of({
    ...inner,
    commit: (id, commit) => Ref.getAndSet(armed, Option.none()).pipe(Effect.flatMap((mode) =>
      Option.isSome(mode) && commit.events.some((event) => event.kind === "turn.started")
        ? mode.value === "landed" ? inner.commit(id, commit).pipe(Effect.andThen(Effect.fail(stalled))) : Effect.fail(stalled)
        : inner.commit(id, commit))),
  })
  return { log, arm: (mode: "landed" | "lost") => Ref.set(armed, Option.some(mode)) }
})

const sessionsOver = (log: Log, config: SessionsConfig) => Layer.build(SessionsLive(config).pipe(Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), TurnAdmissionOpen)))).pipe(Effect.map(Context.get(Sessions)))
const run = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(body).pipe(Effect.provide(TestClock.layer())))
const outcome = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) => Effect.result(effect).pipe(Effect.map((result) => result._tag === "Success" ? "begun" : result.failure._tag))

describe("a begin whose opening commit failed with a store error", () => {
  test("whose commit landed all the same leaves no turn held: the next begin on the instance reaps it, under process ownership too", () => run(Effect.gen(function* () {
    const { log, arm } = yield* failingOnce
    const sessions = yield* sessionsOver(log, processMode)
    const view = yield* sessions.create({ owner })
    const address: SessionAddress = { id: view.header.id, owner }
    yield* arm("landed")
    const first = yield* outcome(Effect.scoped(sessions.begin(address, say("first"))))
    // Stored, yet held by nobody: the view shows no open turn.
    const stored = (yield* sessions.read(address, { kinds: ["turn.started"] })).length === 1
    const open = Option.map((yield* sessions.get(address)).open, (turn) => turn.turn)
    const second = yield* outcome(Effect.scoped(sessions.begin(address, say("second")).pipe(Effect.flatMap((writer) => writer.end({ reason: "completed", failure: Option.none() })))))
    const ended = (yield* sessions.read(address, { kinds: ["turn.ended"] })).map((event) => [Option.getOrNull(event.turn), event.data["reason"], (event.data["failure"] as { readonly code: string } | null)?.code ?? null])
    expect({ first, stored, open, second, ended }).toEqual({
      first: "SessionLogError", stored: true, open: Option.none(), second: "begun",
      ended: [[1, "interrupted", "turn.lease"], [2, "completed", null]],
    })
  })))

  test("whose commit did not land is begun again under its run id and held: a later delivery does not reap it", () => run(Effect.gen(function* () {
    const { log, arm } = yield* failingOnce
    const sessions = yield* sessionsOver(log, processMode)
    const view = yield* sessions.create({ owner })
    const address: SessionAddress = { id: view.header.id, owner }
    yield* arm("lost")
    const first = yield* outcome(Effect.scoped(sessions.begin(address, say("retried"))))
    const writer = yield* sessions.begin(address, say("retried"))
    yield* sessions.deliver(address, { id: "item-1" as never, source: {}, content: "a notice" })
    const open = Option.map((yield* sessions.get(address)).open, (turn): ReadonlyArray<string | number> => [turn.turn, turn.runId])
    yield* writer.append([{ kind: "host.note", data: {} }])
    yield* writer.flush
    expect({ first, turn: writer.admitted.turn, open }).toEqual({ first: "SessionLogError", turn: 1, open: Option.some([1, "run-retried"]) })
    yield* writer.end({ reason: "completed", failure: Option.none() })
  })))
})

describe("a begin whose opening commit failed after another's did", () => {
  test("keeps both turns let go: the earlier one, stored and still open, is reaped by the next begin", () => run(Effect.gen(function* () {
    const { log, arm } = yield* failingOnce
    const sessions = yield* sessionsOver(log, processMode)
    const view = yield* sessions.create({ owner })
    const address: SessionAddress = { id: view.header.id, owner }
    yield* arm("landed")
    const first = yield* outcome(Effect.scoped(sessions.begin(address, say("first"))))
    // This one would reap turn 1 and open turn 2, but nothing of it is stored.
    yield* arm("lost")
    const second = yield* outcome(Effect.scoped(sessions.begin(address, say("second"))))
    const third = yield* outcome(Effect.scoped(sessions.begin(address, say("third")).pipe(Effect.flatMap((writer) => writer.end({ reason: "completed", failure: Option.none() })))))
    const ended = (yield* sessions.read(address, { kinds: ["turn.ended"] })).map((event) => [Option.getOrNull(event.turn), event.data["reason"]])
    expect({ first, second, third, ended }).toEqual({ first: "SessionLogError", second: "SessionLogError", third: "begun", ended: [[1, "interrupted"], [2, "completed"]] })
  })))
})

describe("a turn's time limit", () => {
  test("stops with the turn: a turn that ended is never read again for its limit while its scope stays open", () => run(Effect.gen(function* () {
    const inner = Context.get(yield* Layer.build(SessionLogMemoryLive), SessionLog)
    const heads = yield* Ref.make(0)
    const log: Log = SessionLog.of({ ...inner, head: (id) => Ref.update(heads, (n) => n + 1).pipe(Effect.andThen(inner.head(id))) })
    const sessions = yield* sessionsOver(log, sessionsDefaults)
    const view = yield* sessions.create({ owner })
    const address: SessionAddress = { id: view.header.id, owner }
    const writer = yield* sessions.begin(address, { ...say("limited"), timeLimitMs: 1_000 })
    yield* writer.end({ reason: "completed", failure: Option.none() })
    const before = yield* Ref.get(heads)
    yield* TestClock.adjust(5_000)
    expect((yield* Ref.get(heads)) - before).toBe(0)
  })))
})
