import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import { Agent, inMemoryStorage, windowMemory, windowPressureEvent } from "../../index.js"
import { answering, recording } from "../../testing.js"

const system = "You are a friendly tutor."

/*
 * `plugin.window.pressure`: the window memory says, live, that a request
 * was sent close to the budget. It is published from a background
 * listener, so a host reads it from the stream, started before the turn.
 */
describe("plugin.window.pressure", () => {
  /**
   * Turns under a budget of 40 tokens, whose requests cost 11, 22 and 33,
   * and every pressure event a listener heard of them. The listener is one
   * the publisher waits for, and the agent is replaced before it is asked:
   * `with` returns when every listener has handled what was published, so
   * no pressure is still on its way.
   */
  const pressed = (pressureAt: number | undefined, turns: number) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { model } = yield* answering("An answer of some length.")
    const heard = yield* recording([windowPressureEvent])
    const agent = yield* Agent.define({ model, system, storage: inMemoryStorage(), memory: windowMemory(pressureAt === undefined ? { budgetTokens: 40 } : { budgetTokens: 40, pressureAt }), plugins: [heard.plugin] })
    const session = yield* agent.createSession({ owner: "learner" })
    yield* Effect.forEach(Array.from({ length: turns }), (_, index) => agent.send(session, `Message number ${index + 1}`), { concurrency: 1 })
    const requests = (yield* agent.inspect(session)).requests.map((request) => Number(request.estimatedTokens))
    yield* agent.with({})
    return { published: yield* heard.seen, requests }
  })).pipe(Effect.timeout("5 seconds")))

  test("is not published for a request under the share of the budget it was told, and is published once for each one at or over it, with that request's estimate and the budget", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { model } = yield* answering("An answer of some length.")
      const agent = yield* Agent.define({ model, system, storage: inMemoryStorage(), memory: windowMemory({ budgetTokens: 40, pressureAt: 0.5 }) })
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
