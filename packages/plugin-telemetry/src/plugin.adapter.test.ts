import { describe, expect, test } from "bun:test"
import { LanguageModel } from "effect/ai"
import { Effect, Exit, Layer } from "effect"
import { isHarnessError, RunContext, TurnEvents } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "@xandreed/sdk"
import { telemetryPlugin, TelemetryPluginLive } from "./plugin.adapter.js"

const codeOf = (exit: Exit.Exit<unknown, unknown>): string => Exit.match(exit, {
  onSuccess: () => "succeeded",
  onFailure: (cause) => {
    const error = cause.reasons.flatMap((reason) => reason._tag === "Fail" ? [reason.error] : [])[0]
    return isHarnessError(error) ? `${error.code}: ${error.message}` : String(cause)
  },
})

describe("telemetryPlugin", () => {
  test("is session-scoped, keeps the earlier plugin's id, and requires the turn's RunContext and TurnEvents", () => {
    expect({ id: telemetryPlugin.id, version: telemetryPlugin.version, scope: telemetryPlugin.scope, requires: telemetryPlugin.requires, provides: telemetryPlugin.provides })
      .toEqual({ id: "@xandreed/plugin-telemetry", version: "0.14.0", scope: "session", requires: [RunContext.key, TurnEvents.key], provides: [] })
    expect(telemetryPlugin.defaults).toEqual({ prices: {}, metricAttributes: {}, spanEvents: true })
  })

  test("refuses the options of the plugin it replaces, enabled and serviceName", async () => {
    const define = (options: Readonly<Record<string, unknown>>) => Effect.runPromise(Effect.scoped(Agent.define({
      plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin, { plugin: telemetryPlugin, options }],
      turnServices: [LanguageModel.LanguageModel],
    })).pipe(Effect.exit)).then(codeOf)
    expect(await define({ enabled: true, serviceName: "efferent" })).toStartWith("config.options")
    expect(await define({ enabled: true, serviceName: "efferent" })).toContain("enabled")
    expect(await define({ serviceName: "efferent" })).toStartWith("config.options")
    expect(await define({ prices: { "anthropic:claude": { input: -1, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } } })).toStartWith("config.options")
    expect(await define({ prices: { "anthropic:claude": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }, spanEvents: false })).toBe("succeeded")
  })

  test("as a typed layer, decodes its options the same way", async () => {
    const built = (options: Readonly<Record<string, unknown>>) => Effect.runPromise(Effect.scoped(Layer.build(
      TelemetryPluginLive(options).pipe(Layer.provide(Layer.mergeAll(
        Layer.succeed(RunContext, { session: { id: "s", owner: "o" }, runId: "r", admitted: { turn: 1 } } as never),
        Layer.succeed(TurnEvents, { subscribe: () => Effect.void } as never),
      ))),
    )).pipe(Effect.exit)).then(codeOf)
    expect(await built({ enabled: false })).toStartWith("config.options")
    expect(await built({ metricAttributes: { "deployment.environment": "test" } })).toBe("succeeded")
  })
})
