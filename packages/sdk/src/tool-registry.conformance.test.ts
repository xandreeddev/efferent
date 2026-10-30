import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import type { Tool, Toolkit } from "effect/ai"
import { Capabilities, RunContext, SessionEnvironment, ToolRegistry } from "@xandreed/core"
import type { Capability } from "@xandreed/core"
import type { ConformanceCheck } from "@xandreed/core/conformance"
import { makeRegistry, toolDiscoveryDefaults, ToolDiscoveryLive } from "@xandreed/plugin-tool-discovery"
import { toolRegistryConformance } from "./turn/tool-registry.conformance.js"
import type { ToolRegistryLimits } from "./turn/tool-registry.conformance.js"

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
  test("one that ignores the writer's flush fails only the started-durable check", async () => {
    const unflushed = (capabilities: ReadonlyArray<Capability>, limits: ToolRegistryLimits) => plugin(capabilities, limits).pipe(Effect.map((registry) => ToolRegistry.of({
      ...registry,
      open: (session) => Effect.gen(function* () {
        const run = yield* RunContext
        return yield* registry.open(session).pipe(Effect.provideService(RunContext, { ...run, flush: Effect.void }))
      }),
    })))
    expect(await failedChecks(toolRegistryConformance(unflushed))).toEqual(["started-durable"])
  })

  test("one that drops the provider call id fails only the provider-call-id check", async () => {
    const forgetful = (capabilities: ReadonlyArray<Capability>, limits: ToolRegistryLimits) => plugin(capabilities, limits).pipe(Effect.map((registry) => ToolRegistry.of({
      ...registry,
      open: (session) => registry.open(session).pipe(Effect.flatMap((tools) => tools.toolkit.toHandlers(Object.fromEntries(Object.values(tools.toolkit.tools).map((tool) => {
        const own: Tool.Handler<string> = tools.handlers.mapUnsafe.get(tool.id)
        const handler = (params: unknown, context: Toolkit.HandlerContext<Tool.Any>) => own.handler(params, { ...context, toolCallId: undefined }).pipe(
          Effect.updateContext((input: Context.Context<never>) => Context.merge(own.context, input)),
        )
        return [tool.name, handler]
      }))).pipe(Effect.map((handlers) => ({ ...tools, handlers }))))),
    })))
    expect(await failedChecks(toolRegistryConformance(forgetful))).toEqual(["provider-call-id"])
  })

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

  test("one that opens a run's tools without checking the services they declare fails only the requires-missing check", async () => {
    const unchecked = (capabilities: ReadonlyArray<Capability>, limits: ToolRegistryLimits) => plugin(capabilities.map((capability) => ({
      ...capability,
      tools: capability.tools.map((entry) => ({ tool: entry.tool, handler: entry.handler, view: entry.view, annotations: entry.annotations })),
    })), limits)
    expect(await failedChecks(toolRegistryConformance(unchecked))).toEqual(["requires-missing"])
  })

  test("one that opens the tools over services of its own fails the declared-services checks: the handler sees its workspace, and a run lacking one still opens", async () => {
    const own = (capabilities: ReadonlyArray<Capability>, limits: ToolRegistryLimits) => plugin(capabilities, limits).pipe(Effect.map((registry) => ToolRegistry.of({
      ...registry,
      open: (session) => registry.open(session).pipe(Effect.provideService(SessionEnvironment, { workspace: "the registry's" })),
    })))
    expect(await failedChecks(toolRegistryConformance(own))).toEqual(["requires-missing", "requires-opened"])
  })

  test("one that returns its failures to the model under a host's code fails the load-refusal check and every refusal's", async () => {
    // The plugin's handlers, each failure renamed to a framework code on its way to the model.
    const leaky = (capabilities: ReadonlyArray<Capability>, limits: ToolRegistryLimits) => plugin(capabilities, limits).pipe(Effect.map((registry) => ToolRegistry.of({
      ...registry,
      open: (session) => registry.open(session).pipe(Effect.flatMap((tools) => tools.toolkit.toHandlers(Object.fromEntries(Object.values(tools.toolkit.tools).map((tool) => {
        const own: Tool.Handler<string> = tools.handlers.mapUnsafe.get(tool.id)
        const handler = (params: unknown, context: unknown) => own.handler(params, context).pipe(
          Effect.updateContext((input: Context.Context<never>) => Context.merge(own.context, input)),
          Effect.mapError((failure: { readonly message: string }) => ({ error: "registry.refused", message: failure.message })),
        )
        return [tool.name, handler]
      }))).pipe(Effect.map((handlers) => ({ ...tools, handlers }))))),
    })))
    expect(await failedChecks(toolRegistryConformance(leaky))).toEqual([
      "load-refusal", "refused-call-limit", "refused-denied", "refused-forbidden", "refused-inactive", "refused-tool-call-limit",
    ])
  })

  test("one whose catalog leaves out the permissions a tool needs fails only the catalog check", async () => {
    const unguarded = (capabilities: ReadonlyArray<Capability>, limits: ToolRegistryLimits) => plugin(capabilities, limits).pipe(Effect.map((registry) => ToolRegistry.of({
      ...registry,
      catalog: { ...registry.catalog, tools: registry.catalog.tools.map((tool) => ({ ...tool, permissions: [] })) },
    })))
    expect(await failedChecks(toolRegistryConformance(unguarded))).toEqual(["catalog"])
  })
})
