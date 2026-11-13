import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Schema } from "effect"
import { stored, storedEvent } from "@xandreed/core/kernel"
import { Label } from "./testing.port.js"
import { Memory } from "./contracts/memory/memory.port.js"
import { windowMemory } from "./index.js"
import { counting, open, stack } from "./testing.js"

// How a wrapper composes, as docs/adr/0001-kernel-plugin-composition.md relies
// on it. A wrapper requires a contract and provides the same contract, calling
// the one below. `Label` stands in for any contract where nothing else is needed.

const base = Layer.succeed(Label, Label.of({ system: "base" }))

/** A wrapper of `Label` as a plain layer: it hands on what it was given, marked with its label. */
const wrap = (label: string) => Layer.effect(Label, Effect.gen(function* () {
  const inner = yield* Label
  return Label.of({ system: `${label}(${inner.system})` })
}))

/** The same wrapper as a higher-order plugin: given the plugin it wraps, it returns the wrapped one, the inner one hidden. */
const wrapping = (label: string) => <E, R>(inner: Layer.Layer<Label, E, R>): Layer.Layer<Label, E, R> =>
  wrap(label).pipe(Layer.provide(inner))

/** A part that uses the contract, writing down what it was given. */
const consumer = (seen: Array<string>) => Layer.effectDiscard(Effect.gen(function* () {
  seen.push((yield* Label).system)
}))

/** What the part saw, and which `Label` leaves the composition. */
const run = async (layer: (seen: Array<string>) => Layer.Layer<Label>) => {
  const seen: Array<string> = []
  const left = await Effect.runPromise(Effect.gen(function* () {
    return (yield* Label).system
  }).pipe(Effect.provide(layer(seen))))
  return { seen, left }
}

describe("wrapping a contract with plain layers", () => {
  test("a part composed above a wrapper is given the wrapped contract", async () => {
    expect(await run((seen) => consumer(seen).pipe(Layer.provideMerge(wrap("A")), Layer.provideMerge(base))))
      .toEqual({ seen: ["A(base)"], left: "A(base)" })
  })

  test("two wrappers stack in the order they are composed", async () => {
    expect(await run((seen) => consumer(seen).pipe(Layer.provideMerge(wrap("B")), Layer.provideMerge(wrap("A")), Layer.provideMerge(base))))
      .toEqual({ seen: ["B(A(base))"], left: "B(A(base))" })
  })

  test("a wrapper composed above the part that uses the contract wraps nothing for it, and nothing says so", async () => {
    expect(await run((seen) => wrap("A").pipe(Layer.provideMerge(consumer(seen)), Layer.provideMerge(base))))
      .toEqual({ seen: ["base"], left: "A(base)" })
  })
})

describe("wrapping a contract with higher-order plugins", () => {
  test("a wrapper applied to a plugin reaches the part that uses the contract, wherever the stack is composed", async () => {
    const LabelLive = base.pipe(wrapping("A"))
    expect(await run((seen) => consumer(seen).pipe(Layer.provideMerge(LabelLive))))
      .toEqual({ seen: ["A(base)"], left: "A(base)" })
  })

  test("the last one applied is the outermost: it runs first on the way in", async () => {
    const LabelLive = base.pipe(wrapping("A"), wrapping("B"))
    expect(await run((seen) => consumer(seen).pipe(Layer.provideMerge(LabelLive))))
      .toEqual({ seen: ["B(A(base))"], left: "B(A(base))" })
  })

  test("type-level: a wrapper applied to another contract's plugin does not compile", () => {
    const memory = windowMemory({ budgetTokens: 3000 })
    // @ts-expect-error a wrapper of Label takes a plugin of Label
    const wrong = memory.pipe(wrapping("A"))
    expect(wrong).toBeDefined()
  })

  test("a wrapper applied to a layer that provides more than its contract compiles, and hides the rest", async () => {
    class Extra extends Context.Reference<number>("wrapping.test/Extra", { defaultValue: () => 0 }) {}
    const more = Layer.merge(base, Layer.succeed(Extra, 7))
    const wrapped = more.pipe(wrapping("A"))
    const extra = await Effect.runPromise(Effect.gen(function* () {
      return yield* Extra
    }).pipe(Effect.provide(wrapped)))
    expect(extra).toBe(0)                               // the wrapper's output holds Label only: Extra falls back to its default
  })
})

describe("memory wrappers that append, then delegate", () => {
  const noted = storedEvent("note", "added", { tags: ["memory"], data: Schema.Struct({ by: Schema.String }), skippable: true })

  /** A memory wrapper as a higher-order plugin: it appends a note of its own, then asks the memory it wraps. */
  const noting = (by: string) => <E, R>(inner: Layer.Layer<Memory, E, R>): Layer.Layer<Memory, E, R> =>
    Layer.effect(Memory, Effect.gen(function* () {
      const memory = yield* Memory
      return Memory.of({ context: (session) => Effect.andThen(session.append(stored(noted, { by })), memory.context(session)) })
    })).pipe(Layer.provide(inner))

  test("the outermost wrapper's entry lands first in the journal, the innermost's last", async () => {
    const notes = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { model } = yield* counting
      const memory = windowMemory({ budgetTokens: 3000 }).pipe(noting("inner"), noting("outer"))
      const agent = yield* open(stack(model, { memory }))
      const session = yield* agent.createSession({ owner: "learner" })
      yield* agent.send(session, "Hello")
      const inspection = yield* agent.inspect(session)
      return inspection.events.filter((event) => event.name === noted.name).map((event) => event.data)
    })))
    expect(notes).toEqual([{ by: "outer" }, { by: "inner" }])
  })
})
