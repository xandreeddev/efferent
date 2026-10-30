import { describe, expect, test } from "bun:test"
import { Tool, Toolkit } from "effect/ai"
import { Context, Effect, Schema, Stream } from "effect"
import { Failure } from "../domain/failure.entity.js"
import type { RunTools, ToolHandlers } from "./tool-registry.port.js"

const Shout = Tool.make("shout", {
  description: "Upper-case a text.",
  parameters: Schema.Struct({ text: Schema.String }),
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})
/** The handlers bind to the typed toolkit; a run's toolkit is the erased one, as the registry's is. */
const erased: ReadonlyArray<Tool.Any> = [Shout]
const toolkit: Toolkit.Toolkit<Record<string, Tool.Any>> = Toolkit.make(...erased)

/** One call's last result. An erased tool widens its own services to `any`: this one reads none. */
const shout = (kit: Toolkit.WithHandler<Record<string, Tool.Any>>) => Effect.gen(function* () {
  const results = yield* Stream.runCollect(yield* kit.handle(Shout.name, { text: "hi" }))
  return results.at(-1)?.result
}) as Effect.Effect<unknown, unknown>

describe("a run's tool handlers", () => {
  test("typed handlers are a handler bag, and provided to the run's toolkit they meet its requirement as they are", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const handlers: RunTools["handlers"] = yield* Toolkit.make(Shout).toHandlers({ shout: ({ text }) => Effect.succeed(text.toUpperCase()) })
      // Nothing is left to provide.
      const handled: Effect.Effect<Toolkit.WithHandler<Record<string, Tool.Any>>> = toolkit.pipe(Effect.provide(handlers))
      return yield* shout(yield* handled)
    }))
    expect(result).toBe("HI")
  })

  test("a context without the tools' handlers is not a handler bag", () => {
    // @ts-expect-error -- an empty context handles no tool: build the bag with the toolkit's `toHandlers`.
    const empty: Context.Context<ToolHandlers> = Context.empty()
    expect(empty.mapUnsafe.size).toBe(0)
  })
})
