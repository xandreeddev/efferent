import { resolve, relative } from "node:path"
import { Effect, Layer, Option, Schema } from "effect"
import { ActionPolicy, Approval, definePlugin, HarnessError, SessionEnvironment } from "@xandreed/core"

export const workspacePolicyPlugin = definePlugin({
  id: "@xandreed/plugin-policy-workspace", version: "0.2.0-next.0", config: Schema.Struct({}), defaults: {},
  requires: [SessionEnvironment, Approval], provides: [ActionPolicy],
  layer: () => Layer.effect(ActionPolicy, Effect.gen(function* () {
    const { workspace } = yield* SessionEnvironment
    const approval = yield* Approval
    return ActionPolicy.of({ authorize: (tool, input) => Effect.gen(function* () {
      const args = input !== null && typeof input === "object" ? input as Record<string, unknown> : {}
      const path = typeof args.path === "string" ? Option.some(args.path) : typeof args.dir === "string" ? Option.some(args.dir) : Option.none<string>()
      const outside = Option.exists(path, (value) => {
        const local = relative(workspace, resolve(workspace, value))
        return local === ".." || local.startsWith("../")
      })
      const needsApproval = outside || tool === "external_command" || tool === "mcp_call"
      if (!needsApproval) return
      const accepted = yield* approval.request(`${tool}\n${JSON.stringify(input, null, 2)}`)
      if (!accepted) return yield* Effect.fail(new HarnessError({ code: "action.denied", message: `Permission denied for ${tool}` }))
    }) })
  })),
})
export default workspacePolicyPlugin
