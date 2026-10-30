import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Option, Ref } from "effect"
import { Capabilities } from "../ports/capability.port.js"
import { ActionPolicy, SessionEnvironment } from "../ports/harness.port.js"
import { defineCapability } from "./capability.entity.functions.js"
import { CapabilitiesLive, stackPlugins } from "./plugin-stack.adapter.js"

const [a, b] = ["a", "b"].map((id) => defineCapability({ id, version: "1" }))

/** A plugin-like layer: reads the capabilities below it, provides a service, contributes one bundle. */
const reader = Layer.merge(
  Layer.effect(SessionEnvironment, Capabilities.pipe(Effect.map((below) => ({ workspace: below.map((bundle) => bundle.id).join(",") })))),
  CapabilitiesLive(b!),
)

const read = <E>(layer: Layer.Layer<Capabilities | SessionEnvironment, E>) => Effect.runPromise(Effect.gen(function* () {
  const capabilities = yield* Capabilities
  const environment = yield* SessionEnvironment
  return { capabilities: capabilities.map((bundle): string => bundle.id), workspace: environment.workspace }
}).pipe(Effect.provide(layer)))

describe("stackPlugins", () => {
  test("next is built over base; capabilities concatenate base first", async () => {
    expect(await read(CapabilitiesLive(a!).pipe(stackPlugins(reader)))).toEqual({ capabilities: ["a", "b"], workspace: "a" })
  })

  test("any other service of next wins; capabilities below are kept", async () => {
    const stacked = CapabilitiesLive(a!).pipe(stackPlugins(reader), stackPlugins(Layer.succeed(SessionEnvironment, { workspace: "top" })))
    expect(await read(stacked)).toEqual({ capabilities: ["a", "b"], workspace: "top" })
  })

  test("a layer both levels use is built once", async () => {
    const built = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const count = yield* Ref.make(0)
      const shared = Layer.effect(ActionPolicy, Ref.update(count, (n) => n + 1).pipe(Effect.as({ authorize: () => Effect.void })))
      const base = Layer.effect(Capabilities, ActionPolicy.pipe(Effect.as([a!]))).pipe(Layer.provide(shared))
      const next = Layer.effect(SessionEnvironment, ActionPolicy.pipe(Effect.as({ workspace: "next" }))).pipe(Layer.provide(shared))
      yield* Layer.build(base.pipe(stackPlugins(next)))
      return yield* Ref.get(count)
    })))
    expect(built).toBe(1)
  })

  test("what is built over a stack memoizes in the composition's memo map, not the stack's own", async () => {
    const seen = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const memoMap = yield* Layer.makeMemoMap
      const scope = yield* Effect.scope
      const over = (below: Layer.Layer<Capabilities>) => Layer.effect(SessionEnvironment, Effect.serviceOption(Layer.CurrentMemoMap).pipe(
        Effect.map((current) => ({ workspace: Option.exists(current, (map) => map === memoMap) ? "composition" : "other" })),
      )).pipe(Layer.provide(below))
      const workspace = (below: Layer.Layer<Capabilities>) => Layer.buildWithMemoMap(over(below), memoMap, scope).pipe(
        Effect.map((context) => Context.get(context, SessionEnvironment).workspace),
      )
      return [yield* workspace(CapabilitiesLive(a!)), yield* workspace(CapabilitiesLive(a!).pipe(stackPlugins(reader)))]
    })))
    expect(seen).toEqual(["composition", "composition"])
  })

  test("a merge keeps only one array, which is why contributing layers are stacked, never merged", async () => {
    const merged = Layer.merge(CapabilitiesLive(a!), reader).pipe(Layer.provide(CapabilitiesLive()))
    expect(await read(merged)).toEqual({ capabilities: ["b"], workspace: "" })
  })
})
