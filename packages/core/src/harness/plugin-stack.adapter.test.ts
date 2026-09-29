import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Capabilities } from "../ports/capability.port.js"
import { SessionEnvironment } from "../ports/harness.port.js"
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
  return { capabilities: capabilities.map((bundle) => bundle.id), workspace: environment.workspace }
}).pipe(Effect.provide(layer)))

describe("stackPlugins", () => {
  test("next is built over base; capabilities concatenate base first", async () => {
    expect(await read(CapabilitiesLive(a!).pipe(stackPlugins(reader)))).toEqual({ capabilities: ["a", "b"], workspace: "a" })
  })

  test("any other service of next wins; capabilities below are kept", async () => {
    const stacked = CapabilitiesLive(a!).pipe(stackPlugins(reader), stackPlugins(Layer.succeed(SessionEnvironment, { workspace: "top" })))
    expect(await read(stacked)).toEqual({ capabilities: ["a", "b"], workspace: "top" })
  })

  test("a merge keeps only one array, which is why contributing layers are stacked, never merged", async () => {
    const merged = Layer.merge(CapabilitiesLive(a!), reader).pipe(Layer.provide(CapabilitiesLive()))
    expect(await read(merged)).toEqual({ capabilities: ["b"], workspace: "" })
  })
})
