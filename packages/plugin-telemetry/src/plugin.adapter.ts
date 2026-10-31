import { CurrentModelCallRecorder, definePlugin, RunContext, TurnEvents } from "@xandreed/core"
import { TelemetryOptions, telemetryDefaults } from "./telemetry.entity.js"
import { TurnTelemetryLive } from "./turn-telemetry.adapter.js"

/**
 * Usage, cost and tool telemetry for every turn (`TurnTelemetryLive`):
 * session-scoped, built per turn over the turn's `RunContext` and
 * `TurnEvents`, so under `Agent.turn` it is built inside the turn's
 * `agent.turn` span. Its ordinary event subscription closes with the plugin;
 * its optional recorder observation lives until TurnLive closes, including
 * late helper and reply work. It
 * provides nothing and exports nothing: the host provides an exporter
 * around its program (`OtlpTelemetryLive`). It keeps the id of the plugin
 * this package shipped before 0.11.0, whose options (`enabled`,
 * `serviceName`) it refuses.
 */
export const telemetryPlugin = definePlugin({
  id: "@xandreed/plugin-telemetry", version: "0.14.0", scope: "session",
  config: TelemetryOptions, defaults: telemetryDefaults,
  requires: [RunContext, TurnEvents], optional: [CurrentModelCallRecorder], provides: [],
  layer: (config) => TurnTelemetryLive(config),
})
/**
 * The telemetry plugin as a typed layer: requires the turn's RunContext and TurnEvents; provides nothing.
 *
 * @public
 */
export const TelemetryPluginLive = telemetryPlugin.live
