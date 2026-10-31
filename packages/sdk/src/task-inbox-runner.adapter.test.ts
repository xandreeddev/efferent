import { expect, test } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { ConversationId, InboxRunner, RunId, SessionLogMemoryLive, SessionMissing, Sessions, Tasks, TurnAdmissionOpen, UserMessage } from "@xandreed/core"
import type { TurnEnding, TurnWriter } from "@xandreed/core"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { taskInboxRunner } from "./task-inbox-runner.adapter.js"

const unusedTasks = Tasks.of({
  start: () => Effect.die("unused"), status: () => Effect.die("unused"), list: () => Effect.die("unused"), cancel: () => Effect.die("unused"),
  reconcile: () => Effect.die("unused"), ask: () => Effect.die("unused"), answer: () => Effect.die("unused"), steer: () => Effect.die("unused"), execute: () => Effect.die("unused"),
})
const setup = Effect.gen(function* () {
  const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
  const address = { owner: "task-bridge", id: ConversationId.make("00000000-0000-4000-8000-000000006039") }
  yield* sessions.create(address)
  return { sessions, address }
})

test("task routing borrows the exact writer and composes parent repair with the base post-end observer", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const { sessions, address } = yield* setup
  const child = { ...address, id: ConversationId.make("00000000-0000-4000-8000-000000006040") }
  yield* sessions.fork(address, { id: child.id, origin: "task", inherit: false })
  const seen: TurnWriter[] = []
  const ends: TurnEnding[] = []
  const repairs: unknown[] = []
  const tasks = Tasks.of({ ...unusedTasks,
    execute: (writer) => Effect.sync(() => { seen.push(writer); return { outcome: "waiting" as const, reply: Option.none() } }),
    reconcile: (parent, options) => Effect.sync(() => { repairs.push([parent, options]); return { delivered: 1, started: 0 } }),
  })
  const base = InboxRunner.of({ run: () => Effect.die("task child used the ordinary runner"), afterEnd: (_writer, ending) => Effect.sync(() => { ends.push(ending) }) })
  const runner = Context.get(yield* Layer.build(taskInboxRunner(base).pipe(Layer.provide(Layer.merge(Layer.succeed(Sessions, sessions), Layer.succeed(Tasks, tasks))))), InboxRunner)
  const writer = yield* sessions.begin(child, { _tag: "Task", task: { taskId: child.id, parent: address.id }, runId: RunId.make("bridge-task"), key: "bridge-task", userMessage: new UserMessage({ text: "work" }) })
  expect(yield* runner.run(writer)).toEqual({ outcome: "waiting", reply: Option.none() })
  expect(seen).toEqual([writer])
  expect(yield* sessions.read(child, { kinds: ["turn.ended"] })).toHaveLength(0)
  const ending: TurnEnding = { reason: "waiting", failure: Option.none() }
  yield* writer.end(ending)
  yield* runner.afterEnd?.(writer, ending) ?? Effect.die("missing handoff")
  expect(repairs).toEqual([[address, { react: true }]])
  expect(ends).toEqual([ending])
}))))

test("bridge failures keep fixed model-facing words when a session or its parent is unavailable", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const { sessions, address } = yield* setup
  const writer = yield* sessions.begin(address, { _tag: "User", runId: RunId.make("bridge-errors"), key: "bridge-errors", userMessage: new UserMessage({ text: "work" }), command: {} })
  const build = (subject: Context.Service.Shape<typeof Sessions>) => Layer.build(taskInboxRunner(InboxRunner.of({ run: () => Effect.die("unexpected base call") })).pipe(
    Layer.provide(Layer.merge(Layer.succeed(Sessions, subject), Layer.succeed(Tasks, unusedTasks))),
  )).pipe(Effect.map(Context.get(InboxRunner)))
  const missing = yield* build(Sessions.of({ ...sessions, get: () => Effect.fail(new SessionMissing({ session: address.id })) }))
  const absent = yield* Effect.result(missing.run(writer))
  expect(absent._tag === "Failure" && absent.failure.message).toBe("The inbox session is unavailable.")
  const parentless = yield* build(Sessions.of({ ...sessions, get: (address) => sessions.get(address).pipe(Effect.map((view) => ({ ...view, header: { ...view.header, origin: "task", parent: Option.none() } }))) }))
  const orphan = yield* Effect.result(parentless.afterEnd?.(writer, { reason: "waiting", failure: Option.none() }) ?? Effect.die("missing handoff"))
  expect(orphan._tag === "Failure" && orphan.failure.message).toBe("The task session has no parent.")
}))))
