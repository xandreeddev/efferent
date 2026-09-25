import { Effect, Layer, Schema } from "effect"
import { ActionPolicy, definePlugin, McpClient, McpError, SessionEnvironment } from "@xandreed/core"
import { McpServerSpec } from "./mcp/config.js"
import { McpClientLive } from "./mcp/mcpClientLive.js"

export const mcpPlugin = definePlugin({
  id: "@xandreed/plugin-mcp", version: "0.4.0", config: Schema.Struct({ servers: Schema.Record({ key: Schema.String, value: McpServerSpec }) }),
  defaults: { servers: {} }, requires: [SessionEnvironment, ActionPolicy], provides: [McpClient],
  layer: ({ servers }) => Layer.effect(McpClient, Effect.gen(function* () {
    const { workspace } = yield* SessionEnvironment
    const policy = yield* ActionPolicy
    const services = yield* Layer.build(McpClientLive(workspace, workspace, Object.entries(servers)))
    const client = yield* McpClient.pipe(Effect.provide(services))
    return McpClient.of({ ...client, callTool: (server, name, args) => policy.authorize("mcp_call", { server, name, args }).pipe(
      Effect.mapError((error) => new McpError({ server, message: error.message })),
      Effect.zipRight(client.callTool(server, name, args)),
    ) })
  })),
})
export default mcpPlugin
