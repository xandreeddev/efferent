import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { Core } from "@xandreed/core/kernel"
import type { KernelEvent } from "@xandreed/core/kernel"
import { windowMemory, windowPressureEvent } from "../../index.js"
import { answering, open, stack } from "../../testing.js"

/*
 * `plugin.window.pressure`: the window memory says, live, that a context it
 * built came close to the budget. It publishes it while it builds, so a
 * listener the publisher waits for has heard it when the turn returns.
 */
describe("plugin.window.pressure", () => {
  /**
   * Turns under a budget of 30 tokens of history. Each message is 4 tokens
   * and each answer 7, so the contexts cost 4, 15 and 26.
   */
  const pressed = (pressureAt: number | undefined, turns: number) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { model } = yield* answering("An answer of some length.")
    const heard = yield* Ref.make<ReadonlyArray<KernelEvent>>([])
    const listener = Layer.effectDiscard(Effect.flatMap(Core, (core) => core.on(windowPressureEvent, (event) => Ref.update(heard, (all) => [...all, event]), { wait: true, name: "heard" })))
    const agent = yield* open(stack(model, { memory: windowMemory(pressureAt === undefined ? { budgetTokens: 30 } : { budgetTokens: 30, pressureAt }), extras: listener }))
    const session = yield* agent.createSession({ owner: "learner" })
    yield* Effect.forEach(Array.from({ length: turns }), (_, index) => agent.send(session, `Message number ${index + 1}`), { concurrency: 1 })
    const inspection = yield* agent.inspect(session)
    return { session, published: yield* Ref.get(heard), names: inspection.events.map((event): string => event.name) }
  })).pipe(Effect.timeout("5 seconds")))

  test("is published once for each context at or over the share of the budget it was told, with that context's estimate and the budget, and stored nowhere", async () => {
    const half = await pressed(0.5, 3)
    expect(half.published.map((event) => [event._tag, event.session === half.session, Number(event.turn), event.data])).toEqual([
      ["Live", true, 2, { estimatedTokens: 15, budgetTokens: 30 }],
      ["Live", true, 3, { estimatedTokens: 26, budgetTokens: 30 }],
    ])
    expect(half.names.filter((name) => name.startsWith("plugin.window."))).toEqual([])
  })

  test("from 0.8 of the budget when it is told nothing, and none while every context stays under it", async () => {
    const byDefault = await pressed(undefined, 3)
    expect(byDefault.published.map((event) => [Number(event.turn), event.data])).toEqual([[3, { estimatedTokens: 26, budgetTokens: 30 }]])
    expect((await pressed(undefined, 2)).published).toEqual([])
  })
})
