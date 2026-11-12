import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Ref, Stream } from "effect"
import { Core, TurnNumber } from "@xandreed/core/kernel"
import { requestSentEvent } from "../../contracts/loop/conversation.entity.js"
import { StepNumber, Tokens } from "../../contracts/loop/request.entity.js"
import type { KernelEvent } from "@xandreed/core/kernel"
import { windowMemory, windowPressureEvent } from "../../index.js"
import { answering, open, stack } from "../../testing.js"

/** The estimate of a probe request, which no turn of these tests reaches. */
const PROBE = 39

/*
 * `plugin.window.pressure`: the window memory says, live, that a request
 * was sent close to the budget. It is published from a background
 * listener, so a host reads it from the stream, started before the turn.
 */
describe("plugin.window.pressure", () => {
  /**
   * Turns under a budget of 40 tokens, whose requests cost 11, 22 and 33,
   * and every pressure event a listener heard of them. The listener is one
   * the publisher waits for. After the turns a probe goes the same way: a
   * request of 39 tokens announced on `Core`, which the window's listener
   * reads after every request before it and announces as pressure. Once the
   * probe's pressure is heard, no pressure of the turns is still on its way.
   */
  const pressed = (pressureAt: number | undefined, turns: number) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { model } = yield* answering("An answer of some length.")
    const heard = yield* Ref.make<ReadonlyArray<KernelEvent>>([])
    const probed = yield* Deferred.make<void>()
    const listener = Layer.effectDiscard(Effect.flatMap(Core, (core) => core.on(windowPressureEvent, (event) =>
      event.data.estimatedTokens === PROBE ? Deferred.succeed(probed, undefined) : Ref.update(heard, (all) => [...all, event]), { wait: true, name: "heard" })))
    const agent = yield* open(stack(model, { memory: windowMemory(pressureAt === undefined ? { budgetTokens: 40 } : { budgetTokens: 40, pressureAt }), extras: listener }))
    const session = yield* agent.createSession({ owner: "learner" })
    yield* Effect.forEach(Array.from({ length: turns }), (_, index) => agent.send(session, `Message number ${index + 1}`), { concurrency: 1 })
    const requests = (yield* agent.inspect(session)).requests.map((request) => Number(request.estimatedTokens))
    const probe: KernelEvent = {
      _tag: "Live",
      session,
      turn: TurnNumber.make(turns + 1),
      name: requestSentEvent.name,
      data: { step: StepNumber.make(1), system: "", messages: [], estimatedTokens: Tokens.make(PROBE), budgetTokens: Tokens.make(40) },
    }
    yield* agent.core.publish(probe)
    yield* Deferred.await(probed)
    return { published: yield* Ref.get(heard), requests }
  })).pipe(Effect.timeout("5 seconds")))

  test("is not published for a request under the share of the budget it was told, and is published once for each one at or over it, with that request's estimate and the budget", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { model } = yield* answering("An answer of some length.")
      const agent = yield* open(stack(model, { memory: windowMemory({ budgetTokens: 40, pressureAt: 0.5 }) }))
      const session = yield* agent.createSession({ owner: "learner" })
      // Read from before the first turn: the stream has no replay. Two are expected, from the second and third turn.
      const live = yield* Effect.forkScoped(Stream.runCollect(Stream.take(Stream.filter(agent.events, (event) => event.name === windowPressureEvent.name), 2)), { startImmediately: true })
      yield* Effect.forEach(["Message number 1", "Message number 2", "Message number 3"], (message) => agent.send(session, message), { concurrency: 1 })
      const published = Array.from(yield* Fiber.join(live))
      const inspection = yield* agent.inspect(session)
      return { published, requests: inspection.requests.map((request) => Number(request.estimatedTokens)), names: inspection.events.map((event): string => event.name) }
    })).pipe(Effect.timeout("5 seconds")))
    // The first request is under half the budget, the second and third are over it.
    expect(result.requests).toEqual([11, 22, 33])
    expect(result.published.map((event) => [event._tag, event.session === undefined ? "no session" : "its session", Number(event.turn), event.data])).toEqual([
      ["Live", "its session", 2, { estimatedTokens: 22, budgetTokens: 40 }],
      ["Live", "its session", 3, { estimatedTokens: 33, budgetTokens: 40 }],
    ])
    // Live only: the journal holds nothing of it.
    expect(result.names.filter((name) => name.startsWith("plugin.window."))).toEqual([])
  })

  test("is published once a request, and for no request under the share: all of what three turns publish, with nothing still on its way", async () => {
    const half = await pressed(0.5, 3)
    expect(half.requests).toEqual([11, 22, 33])
    expect(half.published.map((event) => Number(event.turn))).toEqual([2, 3])
    // From 0.8 of the budget when it is told nothing: 32 tokens of 40, which only the third request reaches.
    const byDefault = await pressed(undefined, 3)
    expect(byDefault.published.map((event) => [Number(event.turn), event.data])).toEqual([[3, { estimatedTokens: 33, budgetTokens: 40 }]])
    // And none at all while every request stays under it.
    expect((await pressed(undefined, 2)).published).toEqual([])
  })
})
