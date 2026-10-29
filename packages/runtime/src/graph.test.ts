import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Option, References, Schema } from "effect"
import { definePlugin, HarnessError } from "@xandreed/core"
import type { Plugin } from "@xandreed/core"
import { activateGraph, graphFingerprint, resolveGraph } from "./graph.js"

import { Value, Consumer, Items } from "./testing.port.js"
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
    await Promise.all(cases.map(async (config) => expect(await Effect.runPromise(Effect.result(resolveGraph({ version: 1, ...config }, [provider, consumer])))).toHaveProperty("_tag", "Failure")))
    const self = { ...provider, requires: [Value.key] }
    expect(await Effect.runPromise(Effect.result(resolveGraph({ version: 1, plugins: [{ id: "a", use: "provider" }] }, [self])))).toHaveProperty("_tag", "Failure")
    expect(await Effect.runPromise(Effect.result(resolveGraph({ version: 1, plugins: [{ id: "a", use: "provider" }] }, [{ ...provider, apiVersion: 99 }])))).toHaveProperty("_tag", "Failure")
  })
  test("plugins of the current API and of every earlier one still supported load", async () => {
    expect(provider.apiVersion).toBe(3)
    const loaded = await Promise.all([1, 2, 3].map((apiVersion) => Effect.runPromise(Effect.result(resolveGraph({ version: 1, plugins: [{ id: "a", use: "provider" }] }, [{ ...provider, apiVersion }])))))
    expect(loaded.map((result) => result._tag)).toEqual(["Success", "Success", "Success"])
  })
  test("bindings select providers and failed activation disposes acquired resources", async () => {
    const released: string[] = []
    const tracked = definePlugin({ ...{
      id: "tracked", version: "1", config: Schema.Struct({}), defaults: {}, provides: [Value],
      layer: () => Layer.effect(Value, Effect.acquireRelease(Effect.succeed(1), () => Effect.sync(() => { released.push("closed") }))),
    } })
    const broken = definePlugin({ id: "broken", version: "1", config: Schema.Struct({}), defaults: {}, requires: [Value], provides: [Consumer], layer: () => Layer.effect(Consumer, Effect.fail(new HarnessError({ code: "test", message: "broken" }))) })
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const graph = yield* resolveGraph({ version: 1, plugins: [{ id: "t", use: "tracked" }, { id: "b", use: "broken" }] }, [tracked, broken])
      yield* activateGraph(graph, "session", Context.empty(), yield* Effect.scope)
    })).pipe(Effect.result))
    expect(released).toEqual(["closed"])
    const graph = await Effect.runPromise(resolveGraph({ version: 1, plugins: [{ id: "a", use: "provider" }, { id: "b", use: "provider" }], bindings: { [Value.key]: "b" } }, [provider]))
    expect(graph.providers[Value.key]).toBe("b")
  })
  test("capabilities concatenate in graph order; consumers wait for every other contributor", async () => {
    const contributor = (id: string, items: ReadonlyArray<string>) => definePlugin({ id, version: "1", config: Schema.Struct({}), defaults: {}, provides: [], contributes: [Items], layer: () => Layer.succeed(Items, items) })
    const collector = definePlugin({ id: "collector", version: "1", config: Schema.Struct({}), defaults: {}, requires: [Items], provides: [Consumer], contributes: [Items],
      layer: () => Layer.mergeAll(Layer.effect(Consumer, Items.pipe(Effect.map((items) => items.length))), Layer.succeed(Items, ["collector"])) })
    const optionalValue = definePlugin({ id: "optional", version: "1", config: Schema.Struct({}), defaults: {}, optional: [Value], provides: [Consumer],
      layer: () => Layer.succeed(Consumer, 0) })
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const graph = yield* resolveGraph({ version: 1, plugins: [{ id: "c", use: "collector" }, { id: "a", use: "a" }, { id: "b", use: "b" }] }, [contributor("a", ["one"]), contributor("b", ["two", "three"]), collector])
      expect(graph.nodes.map((node) => node.entry.id)).toEqual(["a", "b", "c"])
      const context = yield* activateGraph(graph, "session", Context.empty(), yield* Effect.scope)
      return { seen: Context.getOption(context, Consumer).pipe(Option.getOrThrow), all: Context.getOption(context, Items).pipe(Option.getOrThrow) }
    })))
    expect(result).toEqual({ seen: 3, all: ["one", "two", "three", "collector"] })
    const alone = await Effect.runPromise(Effect.result(resolveGraph({ version: 1, plugins: [{ id: "o", use: "optional" }] }, [optionalValue])))
    expect(alone._tag).toBe("Success")
  })
  test("a plugin's layer gets the services it declares and the fiber's settings, not the services around its activation", async () => {
    const valueOr = (fallback: number) => Effect.serviceOption(Value).pipe(Effect.map(Option.getOrElse(() => fallback)))
    const undeclared = definePlugin({ id: "undeclared", version: "1", config: Schema.Struct({}), defaults: {}, provides: [Consumer], layer: () => Layer.effect(Consumer, valueOr(-1)) })
    const declared = definePlugin({ id: "declared", version: "1", config: Schema.Struct({}), defaults: {}, optional: [Value], provides: [Consumer], layer: () => Layer.effect(Consumer, valueOr(-1)) })
    const settings = definePlugin({ id: "settings", version: "1", config: Schema.Struct({}), defaults: {}, provides: [Items], layer: () => Layer.effect(Items, Effect.gen(function* () {
      const span = yield* Effect.currentSpan.pipe(Effect.map((span) => span.name), Effect.orElseSucceed(() => "none"))
      return [span, String((yield* References.CurrentLogAnnotations)["run"])]
    })) })
    const activated = (plugin: Plugin, services: Context.Context<never>) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const graph = yield* resolveGraph({ version: 1, plugins: [{ id: "p", use: plugin.id }] }, [plugin])
      return yield* activateGraph(graph, "session", services, yield* Effect.scope)
    })).pipe(Effect.provideService(Value, 41), Effect.withSpan("activation"), Effect.annotateLogs({ run: "r1" })))
    const consumed = (plugin: Plugin, services: Context.Context<never>) => activated(plugin, services).then((context) => Context.getUnsafe(context, Consumer))
    expect(await consumed(undeclared, Context.empty())).toBe(-1)
    expect(await consumed(undeclared, Context.make(Value, 7))).toBe(-1)
    expect(await consumed(declared, Context.make(Value, 7))).toBe(7)
    expect(await consumed(declared, Context.empty())).toBe(-1)
    expect(Context.getUnsafe(await activated(settings, Context.empty()), Items)).toEqual(["activation", "r1"])
  })
  test("options merge over nested defaults; an object of another shape replaces its default", async () => {
    const nested = definePlugin({
      id: "nested", version: "1",
      config: Schema.Struct({
        inbox: Schema.Struct({ maxPending: Schema.Number, attempts: Schema.Number }),
        holder: Schema.Union([Schema.Struct({ mode: Schema.Literal("lease"), ttlMs: Schema.Number }), Schema.Struct({ mode: Schema.Literal("process") })]),
      }),
      defaults: { inbox: { maxPending: 20, attempts: 2 }, holder: { mode: "lease", ttlMs: 60_000 } },
      provides: [Items], layer: ({ inbox, holder }) => Layer.succeed(Items, [String(inbox.maxPending), String(inbox.attempts), holder.mode]),
    })
    const items = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const graph = yield* resolveGraph({ version: 1, plugins: [{ id: "n", use: "nested", options: { inbox: { maxPending: 50 }, holder: { mode: "process" } } }] }, [nested])
      expect(graph.nodes[0]!.options).toEqual({ inbox: { maxPending: 50, attempts: 2 }, holder: { mode: "process" } })
      return Context.getUnsafe(yield* activateGraph(graph, "session", Context.empty(), yield* Effect.scope), Items)
    })))
    expect(items).toEqual(["50", "2", "process"])
    const typo = await Effect.runPromise(Effect.flip(resolveGraph({ version: 1, plugins: [{ id: "n", use: "nested", options: { inbox: { maxPending: 50, typo: 1 } } }] }, [nested])))
    expect(typo).toMatchObject({ code: "config.options", plugin: "n", cause: { _tag: "SchemaError" } })
    expect(typo.message).toContain("typo")
    expect(typo.message).not.toStartWith("SchemaError")
  })
  test("profiles are refused, not ignored", async () => {
    const configs = [
      { version: 1 as const, profile: "review", profiles: { review: { plugins: [{ id: "p", use: "provider" }] } } },
      { version: 1 as const, plugins: [{ id: "p", use: "provider" }], profiles: {} },
      { version: 1 as const, plugins: [{ id: "p", use: "provider" }], profile: "review" },
    ]
    const errors = await Effect.runPromise(Effect.forEach(configs, (config) => Effect.flip(resolveGraph(config, [provider]))))
    expect(errors.map((error) => error.code)).toEqual(["config.profile", "config.profile", "config.profile"])
  })
  test("the fingerprint does not depend on the order keys were written in", async () => {
    const nested = definePlugin({
      id: "nested", version: "1",
      config: Schema.Struct({ a: Schema.Number, b: Schema.Struct({ x: Schema.Number, y: Schema.Number }), labels: Schema.Record(Schema.String, Schema.String) }),
      defaults: { a: 1, b: { x: 1, y: 2 }, labels: {} },
      provides: [Value], layer: ({ a }) => Layer.succeed(Value, a),
    })
    const fingerprint = (config: Parameters<typeof resolveGraph>[0]) => Effect.runPromise(resolveGraph(config, [nested, provider]).pipe(Effect.map((graph) => graphFingerprint(graph))))
    const written = await fingerprint({ version: 1, system: "s", bindings: { [Value.key]: "n" }, plugins: [
      { id: "n", use: "nested", options: { b: { y: 3, x: 2 }, labels: { "z": "1", "b": "2" }, a: 5 } }, { id: "p", use: "provider" },
    ] })
    const reordered = await fingerprint({ plugins: [
      { use: "nested", options: { a: 5, labels: { "b": "2", "z": "1" }, b: { x: 2, y: 3 } }, id: "n" }, { use: "provider", id: "p" },
    ], bindings: { [Value.key]: "n" }, system: "s", version: 1 })
    const other = await fingerprint({ version: 1, system: "s", bindings: { [Value.key]: "n" }, plugins: [
      { id: "n", use: "nested", options: { a: 5, b: { x: 3, y: 2 }, labels: { "b": "2", "z": "1" } } }, { id: "p", use: "provider" },
    ] })
    expect(reordered).toBe(written)
    expect(other).not.toBe(written)
  })
})
