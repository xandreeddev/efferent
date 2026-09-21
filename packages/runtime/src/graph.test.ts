import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { definePlugin, HarnessError } from "@xandreed/core"
import { activateGraph, resolveGraph } from "./graph.js"

import { Value, Consumer } from "./testing.port.js"
const provider = definePlugin({ id: "provider", version: "1", config: Schema.Struct({ value: Schema.Number }), defaults: { value: 1 }, provides: [Value], layer: ({ value }) => Layer.succeed(Value, value) })
const consumer = definePlugin({ id: "consumer", version: "1", config: Schema.Struct({}), defaults: {}, requires: [Value], provides: [Consumer], layer: () => Layer.effect(Consumer, Value.pipe(Effect.map((value) => value + 1))) })

describe("plugin graph", () => {
  test("orders dependencies and validates typed options", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const graph = yield* resolveGraph({ version: 1, plugins: [{ id: "c", use: "consumer" }, { id: "p", use: "provider", options: { value: 41 } }] }, [provider, consumer])
      expect(graph.nodes.map((node) => node.entry.id)).toEqual(["p", "c"])
      const context = yield* activateGraph(graph, "session", Context.empty(), yield* Effect.scope)
      return Context.getOption(context, Consumer).pipe(Option.getOrThrow)
    })))
    expect(result).toBe(42)
  })
  test("rejects missing, ambiguous, cyclic, incompatible and invalid configurations", async () => {
    const cases = [
      { plugins: [{ id: "c", use: "consumer" }] },
      { plugins: [{ id: "a", use: "provider" }, { id: "b", use: "provider" }] },
      { plugins: [{ id: "a", use: "provider", options: { typo: 1 } }] },
      { plugins: [{ id: "a", use: "missing" }] },
    ]
    await Promise.all(cases.map(async (config) => expect(await Effect.runPromise(Effect.either(resolveGraph({ version: 1, ...config }, [provider, consumer])))).toHaveProperty("_tag", "Left")))
    const self = { ...provider, requires: [Value.key] }
    expect(await Effect.runPromise(Effect.either(resolveGraph({ version: 1, plugins: [{ id: "a", use: "provider" }] }, [self])))).toHaveProperty("_tag", "Left")
    expect(await Effect.runPromise(Effect.either(resolveGraph({ version: 1, plugins: [{ id: "a", use: "provider" }] }, [{ ...provider, apiVersion: 99 }])))).toHaveProperty("_tag", "Left")
  })
  test("bindings select providers and failed activation disposes acquired resources", async () => {
    const released: string[] = []
    const tracked = definePlugin({ ...{
      id: "tracked", version: "1", config: Schema.Struct({}), defaults: {}, provides: [Value],
      layer: () => Layer.scoped(Value, Effect.acquireRelease(Effect.succeed(1), () => Effect.sync(() => { released.push("closed") }))),
    } })
    const broken = definePlugin({ id: "broken", version: "1", config: Schema.Struct({}), defaults: {}, requires: [Value], provides: [Consumer], layer: () => Layer.effect(Consumer, Effect.fail(new HarnessError({ code: "test", message: "broken" }))) })
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const graph = yield* resolveGraph({ version: 1, plugins: [{ id: "t", use: "tracked" }, { id: "b", use: "broken" }] }, [tracked, broken])
      yield* activateGraph(graph, "session", Context.empty(), yield* Effect.scope)
    })).pipe(Effect.either))
    expect(released).toEqual(["closed"])
    const graph = await Effect.runPromise(resolveGraph({ version: 1, plugins: [{ id: "a", use: "provider" }, { id: "b", use: "provider" }], bindings: { [Value.key]: "b" } }, [provider]))
    expect(graph.providers[Value.key]).toBe("b")
  })
})
