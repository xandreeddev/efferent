import { describe, expect, test } from "bun:test"
import { Tool } from "effect/ai"
import { Context, Effect, Layer, Option, Schema } from "effect"
import {
  Capabilities,
  CapabilitiesLive,
  ConversationMemory,
  defineCapability,
  definePlugin,
  defineSkill,
  defineTool,
  Failure,
  stackPlugins,
  StepLoop,
  ToolRegistry,
} from "@xandreed/core"
import type { HarnessConfig, Plugin } from "@xandreed/core"
import { StepLoopLive, stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { MemoryLogLive, memoryLogPlugin } from "@xandreed/plugin-memory-log"
import { MemoryWindowLive, memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { ToolDiscoveryLive, toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { activateGraph, resolveGraph } from "@xandreed/runtime"

const Lookup = Tool.make("lookup", {
  description: "Look records up.", parameters: Schema.Struct({ query: Schema.String }), success: Schema.String, failure: Failure, failureMode: "return",
})
const host = defineCapability({
  id: "stack-host", version: "1",
  tools: [defineTool({ tool: Lookup, handler: ({ query }) => Effect.succeed(query) })],
  skills: [defineSkill({ id: "records", summary: "Look records up.", tools: ["lookup"] })],
  promptSections: [{ id: "persona", version: "1", tier: "session", order: 0, render: () => Effect.succeed(Option.some("persona")) }],
})
const hostPlugin = definePlugin({
  id: "test/host", version: "1", scope: "runtime", config: Schema.Struct({}), defaults: {},
  provides: [], contributes: [Capabilities], layer: () => CapabilitiesLive(host),
})

/** What a composition provides: its service keys, the capabilities in order, and what the services are. */
const shapeOf = (context: Context.Context<never>) => ({
  keys: [...context.mapUnsafe.keys()].sort(),
  capabilities: Context.getUnsafe(context, Capabilities).map((bundle) => bundle.id),
  sections: Context.getUnsafe(context, Capabilities).flatMap((bundle) => bundle.promptSections.map((section) => section.id)),
  catalog: Context.getUnsafe(context, ToolRegistry).catalog,
  strategy: Context.getUnsafe(context, ConversationMemory).strategy,
  loop: Context.getUnsafe(context, StepLoop).id,
})

describe("plugin stacks", () => {
  test("stacking the typed layers equals activating the same plugins as a graph", async () => {
    const { graph, stack } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const plugins: ReadonlyArray<Plugin> = [memoryLogPlugin, memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin, hostPlugin]
      const config: HarnessConfig = { version: 1, plugins: plugins.map((plugin) => ({ id: plugin.id, use: plugin.id, options: {} })), system: "" }
      const resolved = yield* resolveGraph(config, plugins)
      const graph = yield* activateGraph(resolved, "runtime", Context.empty(), yield* Effect.scope)
      const stack = yield* Layer.build(CapabilitiesLive(host).pipe(
        stackPlugins(MemoryLogLive()),
        stackPlugins(MemoryWindowLive()),
        stackPlugins(ToolDiscoveryLive()),
        stackPlugins(StepLoopLive),
      ))
      // A built layer's context also carries the memo map it was built with: not a service of the stack.
      return { graph: shapeOf(graph), stack: shapeOf(Context.makeUnsafe<never>(Context.omit(Layer.CurrentMemoMap)(stack).mapUnsafe)) }
    })))
    expect(stack).toEqual(graph)
    expect(stack.capabilities).toEqual(["stack-host", "@xandreed/plugin-memory-window/recall", "@xandreed/plugin-tool-discovery/catalogue"])
    expect(stack.catalog.tools.map((tool) => tool.id)).toEqual(["lookup", "recall_context", "load_skill"])
  })
})
