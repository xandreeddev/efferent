// The learner's memory, as the page evaluates it, held to the memory kit.
import { describe, expect, test } from "bun:test"
import { Array as Arr, Context, Effect, Layer, Order } from "effect"
import { Core } from "@xandreed/core/kernel"
import type { ConformanceCheck } from "@xandreed/core/kernel"
import { Memory, memoryConformance, Settings, windowMemory } from "@xandreed/sdk/kernel"
import type { MemorySubject } from "@xandreed/sdk/kernel"
import { evaluateTiny } from "./runtime.ts"
import { DEFAULT_TINY } from "./tiny-memory.source.ts"

const system = "You are a friendly tutor. Keep answers short."
const budgetTokens = 3000

/** The ids of the checks that fail, sorted. */
const failedChecks = (checks: ReadonlyArray<ConformanceCheck>) =>
  Effect.runPromise(Effect.forEach(checks, (check) => Effect.map(Effect.result(check.run), (result) => result._tag === "Failure" ? [check.id] : []), { concurrency: 1 }))
    .then((failed) => Arr.sort(failed.flat(), Order.String))

/** `lastMessages` exactly as the page evaluates the default text. */
const lastMessages = evaluateTiny(DEFAULT_TINY) as (options: { readonly n: number; readonly budgetTokens: number }) => Layer.Layer<Memory, never, Settings>

const subject = (n: number): MemorySubject => ({
  name: "last",
  system,
  budgetTokens,
  open: (core) => Effect.map(
    Effect.orDie(Layer.build(Layer.provide(lastMessages({ n, budgetTokens }), Layer.merge(Layer.succeed(Core, core), Layer.succeed(Settings, { system }))))),
    (services) => Context.get(services, Memory),
  ),
})

describe("the learner's lastMessages memory", () => {
  test("passes every check of the memory kit but prefix: a sliding memory changes the start of each request", async () => {
    expect(await failedChecks(memoryConformance(subject(1)))).toEqual(["prefix"])
    expect(await failedChecks(memoryConformance(subject(3)))).toEqual(["prefix"])
  })

  test("the stock window memory, for comparison, passes prefix too", async () => {
    const window: MemorySubject = {
      name: "window", system, budgetTokens,
      open: (core) => Effect.map(
        Effect.orDie(Layer.build(Layer.provide(windowMemory({ budgetTokens }), Layer.merge(Layer.succeed(Core, core), Layer.succeed(Settings, { system }))))),
        (services) => Context.get(services, Memory),
      ),
    }
    expect(await failedChecks(memoryConformance(window))).toEqual([])
  })
})
