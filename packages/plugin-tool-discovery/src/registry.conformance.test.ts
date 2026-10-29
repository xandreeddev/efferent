import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { Capabilities, ToolRegistry, toolRegistryConformance } from "@xandreed/core"
import type { Capability, ConformanceCheck, ToolRegistryLimits } from "@xandreed/core"
import { toolDiscoveryDefaults, ToolDiscoveryLive } from "./plugin.adapter.js"
import { makeRegistry } from "./registry.adapter.js"

const failedChecks = (checks: ReadonlyArray<ConformanceCheck>) => Effect.runPromise(Effect.forEach(checks, (check) =>
  Effect.result(check.run).pipe(Effect.map((exit) => exit._tag === "Failure" ? [exit.failure.check] : [])))).then((failed) => failed.flat().toSorted())

/** The registry as the plugin builds it, over the kit's capabilities. */
const plugin = (capabilities: ReadonlyArray<Capability>, limits: ToolRegistryLimits) =>
  Layer.build(ToolDiscoveryLive({ ...toolDiscoveryDefaults, ...limits }).pipe(Layer.provide(Layer.succeed(Capabilities, capabilities)))).pipe(
    Effect.map((context) => Context.get(context, ToolRegistry)))

describe("the tool discovery plugin's registry conforms to the ToolRegistry contract", () => {
  toolRegistryConformance(plugin).map((check) => test(check.name, async () => {
    const exit = await Effect.runPromise(Effect.result(check.run))
    expect(exit._tag === "Failure" ? exit.failure.message : "ok").toBe("ok")
  }))
})

describe("the ToolRegistry kit catches careless registries", () => {
  test("one that ignores the turn's call limit fails only the call-limit refusal", async () => {
    const unlimited = (capabilities: ReadonlyArray<Capability>) => makeRegistry({ ...toolDiscoveryDefaults, maxCallsPerRun: 1_000 }, capabilities).pipe(
      Effect.map((registry) => ToolRegistry.of({ catalog: registry.catalog, open: registry.open })))
    expect(await failedChecks(toolRegistryConformance(unlimited))).toEqual(["refused-call-limit"])
  })

  test("one that activates every skill when the tools open fails the checks that call a tool it should not have active", async () => {
    const eager = (capabilities: ReadonlyArray<Capability>, limits: ToolRegistryLimits) => plugin(capabilities, limits).pipe(Effect.map((registry) => ToolRegistry.of({
      ...registry,
      open: (session) => registry.open(session).pipe(Effect.tap((tools) => tools.activate(tools.skills.filter((skill) => skill.permissions.length === 0).map((skill) => skill.id), "host"))),
    })))
    expect(await failedChecks(toolRegistryConformance(eager))).toEqual(["activation", "invocation", "refused-inactive"])
  })

  test("one whose catalog leaves out the permissions a tool needs fails only the catalog check", async () => {
    const unguarded = (capabilities: ReadonlyArray<Capability>, limits: ToolRegistryLimits) => plugin(capabilities, limits).pipe(Effect.map((registry) => ToolRegistry.of({
      ...registry,
      catalog: { ...registry.catalog, tools: registry.catalog.tools.map((tool) => ({ ...tool, permissions: [] })) },
    })))
    expect(await failedChecks(toolRegistryConformance(unguarded))).toEqual(["catalog"])
  })
})
