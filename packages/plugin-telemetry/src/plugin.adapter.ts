import { Effect, Layer, Schema } from "effect"
import { definePlugin, TurnHooks } from "@xandreed/core"
import { TracingLive } from "./telemetry/telemetry.js"

export const telemetryPlugin = definePlugin({
  id: "@xandreed/plugin-telemetry", version: "0.3.0", config: Schema.Struct({ enabled: Schema.Boolean, serviceName: Schema.String }),
  defaults: { enabled: false, serviceName: "efferent" }, provides: [TurnHooks],
  layer: ({ enabled, serviceName }) => Layer.succeed(TurnHooks, {
    before: (input) => Effect.succeed(input),
    after: (input) => Effect.annotateCurrentSpan({ "session.id": input.session.id, "run.id": input.runId }),
  }).pipe(Layer.provide(enabled ? TracingLive(serviceName) : Layer.empty)),
})
export default telemetryPlugin
