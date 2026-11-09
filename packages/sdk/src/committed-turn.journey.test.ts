import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Option, Ref, Schema } from "effect"
import {
  CommittedTurnObservers, ConversationId, definePlugin, notifyCommittedTurn, RunId, SessionLogError, SessionIncarnation, SessionLogMemoryLive,
  Sessions, TurnAdmissionOpen, UserMessage,
} from "@xandreed/core"
import type { CommittedTurn, CommittedTurnObserver } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "./agent.adapter.js"

const address = { owner: "fixture", id: ConversationId.make("00000000-0000-4000-8000-0000000000c2") }
const basePlugins = [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin]
const sessionsLayer = SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))
const input = (id: string) => ({ session: address, runId: RunId.make(id), userMessage: new UserMessage({ text: "hello" }) })

describe("committed turn observers through Agent.turn", () => {
  test("a before-turn session plugin observes the stored final reply before its scope closes", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const sessions = Context.get(yield* Layer.build(sessionsLayer), Sessions)
    yield* sessions.create(address)
    const calls = yield* Ref.make<ReadonlyArray<string>>([])
    const capture = definePlugin({
      id: "fixture/committed", version: "1", scope: "session", config: Schema.Struct({}), defaults: {}, requires: [Sessions], provides: [], contributes: [CommittedTurnObservers],
      layer: () => Layer.effect(CommittedTurnObservers, Effect.gen(function* () {
        const ownSessions = yield* Sessions
        yield* Effect.addFinalizer(() => Ref.update(calls, (all) => [...all, "closed"]))
        return [{ id: "capture", committed: (turn: CommittedTurn) => Effect.gen(function* () {
          const events = yield* ownSessions.read(turn.session).pipe(Effect.orDie)
          expect(events.at(-1)?.kind).toBe("turn.ended")
          expect(events.find((event) => event.kind === "turn.reply")?.data.body).toMatchObject({ reply: "host final reply", outcome: "completed" })
          expect(turn.session.incarnation.length).toBeGreaterThan(0)
          expect(turn).toEqual({ session: { ...address, incarnation: turn.session.incarnation }, runId: RunId.make("committed-success"), turn: 1 })
          yield* Ref.update(calls, (all) => [...all, "observed"])
        }) }]
      })),
    })
    const agent = yield* Agent.define({ plugins: [...basePlugins, capture], turnServices: [Sessions] })
    const result = yield* agent.turn({ turn: input("committed-success"), services: Context.make(Sessions, sessions) }, (turn) => turn.reply("host final reply"))
    expect(result.reply).toEqual(Option.some("host final reply"))
    expect(yield* Ref.get(calls)).toEqual(["observed", "closed"])
  }))))

  test("failed turns are observed after their stored end and keep the original failure", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const sessions = Context.get(yield* Layer.build(sessionsLayer), Sessions)
    yield* sessions.create(address)
    const original = new SessionLogError({ code: "store.io", message: "fixture body failure" })
    const seen = yield* Ref.make<ReadonlyArray<string>>([])
    const observer: CommittedTurnObserver = { id: "failed", committed: (turn) => sessions.read(turn.session).pipe(Effect.orDie, Effect.flatMap((events) => Ref.set(seen, events.filter((event) => event.kind === "turn.ended").map((event) => String(event.data.reason))))) }
    const agent = yield* Agent.define({ plugins: basePlugins, turnServices: [Sessions] })
    const result = yield* agent.turn({ turn: input("committed-failure"), services: Context.make(Sessions, sessions).pipe(Context.add(CommittedTurnObservers, [observer])) }, () => Effect.fail(original)).pipe(Effect.result)
    expect(result._tag === "Failure" && result.failure).toBe(original)
    expect(yield* Ref.get(seen)).toEqual(["failed"])
  }))))

  test("an unacknowledged end invokes no observer even if scope cleanup later stores it", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const sessions = Context.get(yield* Layer.build(sessionsLayer), Sessions)
    yield* sessions.create(address)
    const called = yield* Ref.make(false)
    const original = new SessionLogError({ code: "store.io", message: "fixture end acknowledgement failed" })
    const failing = Sessions.of({ ...sessions, begin: (address, next) => sessions.begin(address, next).pipe(Effect.map((writer) => ({ ...writer, end: () => Effect.fail(original) }))) })
    const agent = yield* Agent.define({ plugins: basePlugins, turnServices: [Sessions] })
    const result = yield* agent.turn({ turn: input("commit-failed"), services: Context.make(Sessions, failing).pipe(Context.add(CommittedTurnObservers, [{ id: "not-called", committed: () => Ref.set(called, true) }])) }, (turn) => turn.reply("answer")).pipe(Effect.result)
    expect(result._tag === "Failure" && result.failure).toBe(original)
    expect(yield* Ref.get(called)).toBe(false)
  }))))

  test("observer failure, defect and timeout preserve the original completed outcome", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const sessions = Context.get(yield* Layer.build(sessionsLayer), Sessions)
    yield* sessions.create(address)
    const called = yield* Ref.make(false)
    const agent = yield* Agent.define({ plugins: basePlugins, turnServices: [Sessions] })
    const result = yield* agent.turn({ turn: input("soft-observers"), services: Context.make(Sessions, sessions).pipe(Context.add(CommittedTurnObservers, [
      { id: "defect", committed: () => Effect.die("fixture observer defect") },
      { id: "timeout", committed: () => Effect.never },
      { id: "after", committed: () => Ref.set(called, true) },
    ])) }, (turn) => turn.reply("answer"))
    expect(result).toMatchObject({ outcome: "completed", reply: Option.some("answer") })
    expect(yield* Ref.get(called)).toBe(true)
  }))))

  test("a borrowed writer is observed only when its host ends and explicitly notifies", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const sessions = Context.get(yield* Layer.build(sessionsLayer), Sessions)
    yield* sessions.create(address)
    const called = yield* Ref.make(0)
    const observers = [{ id: "borrowed", committed: () => Ref.update(called, (count) => count + 1) }]
    const writer = yield* sessions.begin(address, { _tag: "User", runId: RunId.make("borrowed"), key: "borrowed", command: {}, userMessage: new UserMessage({ text: "hello" }) })
    const agent = yield* Agent.define({ plugins: basePlugins, turnServices: [Sessions] })
    yield* agent.turn({ turn: writer, services: Context.make(Sessions, sessions).pipe(Context.add(CommittedTurnObservers, observers)) }, (turn) => turn.reply("answer"))
    expect(yield* Ref.get(called)).toBe(0)
    expect((yield* sessions.read(address)).some((event) => event.kind === "turn.ended")).toBe(false)
    yield* writer.end({ reason: "completed", failure: Option.none() })
    yield* notifyCommittedTurn({ session: { ...address, incarnation: SessionIncarnation.make("00000000-0000-4000-8000-0000000000c3") }, runId: writer.admitted.runId, turn: writer.admitted.turn }).pipe(Effect.provideService(CommittedTurnObservers, observers))
    expect(yield* Ref.get(called)).toBe(1)
  }))))
})
