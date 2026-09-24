import { Effect, Layer, Schema } from "effect"
import { Approval, definePlugin } from "@xandreed/core"
import type { HarnessError } from "@xandreed/core"

/** A host supplies interaction; unattended hosts deny requests by default. */
export const approvalPlugin = (request: (description: string) => Effect.Effect<boolean, HarnessError> = () => Effect.succeed(false)) => definePlugin({
  id: "efferent/approval-host", version: "0.3.0", scope: "runtime", config: Schema.Struct({}), defaults: {}, provides: [Approval],
  layer: () => Layer.succeed(Approval, { request }),
})
