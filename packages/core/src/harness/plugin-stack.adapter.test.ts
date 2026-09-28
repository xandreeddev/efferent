import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Contributions } from "../ports/contribution.port.js"
import { SessionEnvironment } from "../ports/harness.port.js"
import { defineContributions } from "./contribution.entity.functions.js"
import { ContributionsLive, stackPlugins } from "./plugin-stack.adapter.js"

const [a, b] = ["a", "b"].map((id) => defineContributions({ id, version: "1" }))

/** A plugin-like layer: reads the contributions below it, provides a service, contributes one bundle. */
const reader = Layer.merge(
  Layer.effect(SessionEnvironment, Contributions.pipe(Effect.map((below) => ({ workspace: below.map((bundle) => bundle.id).join(",") })))),
  ContributionsLive(b!),
)

const read = <E>(layer: Layer.Layer<Contributions | SessionEnvironment, E>) => Effect.runPromise(Effect.gen(function* () {
  const contributions = yield* Contributions
  const environment = yield* SessionEnvironment
  return { contributions: contributions.map((bundle) => bundle.id), workspace: environment.workspace }
}).pipe(Effect.provide(layer)))

describe("stackPlugins", () => {
  test("next is built over base; contributions concatenate base first", async () => {
    expect(await read(ContributionsLive(a!).pipe(stackPlugins(reader)))).toEqual({ contributions: ["a", "b"], workspace: "a" })
  })

  test("any other service of next wins; contributions below are kept", async () => {
    const stacked = ContributionsLive(a!).pipe(stackPlugins(reader), stackPlugins(Layer.succeed(SessionEnvironment, { workspace: "top" })))
    expect(await read(stacked)).toEqual({ contributions: ["a", "b"], workspace: "top" })
  })

  test("a merge keeps only one array, which is why contributing layers are stacked, never merged", async () => {
    const merged = Layer.merge(ContributionsLive(a!), reader).pipe(Layer.provide(ContributionsLive()))
    expect(await read(merged)).toEqual({ contributions: ["b"], workspace: "" })
  })
})
