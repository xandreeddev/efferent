import { expect, test } from "bun:test"
import { Context, Deferred, Effect, Exit, Layer, Option, Ref, Scope } from "effect"
import { ConversationId, DrainActivity, InboxItemId, InboxRunner, SessionLogMemoryLive, Sessions, TurnAdmissionOpen, UserMessage } from "@xandreed/core"
import { InboxDrainLive } from "./inbox-drain.adapter.js"
import { SessionsLive } from "./sessions.adapter.js"
import { sessionsDefaults } from "./sessions-state.entity.js"

test("an afterEnd hook stays interruptible under a masked owner and leaves its input acknowledged", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const context = yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen))))
  const sessions = Context.get(context, Sessions)
  const address = { owner: "after-end-interruption", id: ConversationId.make("00000000-0000-4000-8000-000000005693") }
  yield* sessions.create(address)
  yield* sessions.enqueue(address, { id: InboxItemId.make("acknowledged"), delivery: "next", source: {}, userMessage: new UserMessage({ text: "Run this input once." }) })
  const entered = yield* Deferred.make<void>()
  const interrupted = yield* Deferred.make<void>()
  const calls = yield* Ref.make(0)
  const owner = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
  const runner = InboxRunner.of({
    run: () => Ref.update(calls, (count) => count + 1).pipe(Effect.as({ outcome: "waiting", reply: Option.none() })),
    afterEnd: () => Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Effect.never), Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
    ),
  })
  const drain = yield* Layer.build(InboxDrainLive({ owners: [address.owner], concurrency: 1, resume: { _tag: "Never" } })).pipe(
    Effect.provide(Context.add(context, InboxRunner, runner)), Scope.provide(owner), Effect.uninterruptible,
  )
  yield* Deferred.await(entered)
  expect((yield* sessions.get(address)).pending).toBe(0)
  expect(yield* Context.get(drain, DrainActivity).running).toBe(1)
  yield* Scope.close(owner, Exit.void).pipe(Effect.timeout("1 second"))
  yield* Deferred.await(interrupted).pipe(Effect.timeout("1 second"))
  expect(yield* Ref.get(calls)).toBe(1)
  expect(yield* Context.get(drain, DrainActivity).running).toBe(0)
  expect((yield* sessions.get(address)).pending).toBe(0)
  expect((yield* sessions.read(address, { kinds: ["turn.ended"] })).map((event) => event.data.reason)).toEqual(["waiting"])
})).pipe(Effect.timeout("3 seconds"))))
