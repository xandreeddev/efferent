import { Context, Schema } from "effect"
import type { Effect } from "effect"

/**
 * The MCP client port — external, user-configured tool servers surfaced to
 * agents through the ordinary toolkit machinery (see `mcp/bridge.ts`). The
 * adapter owns transport (stdio JSON-RPC) and lifecycle; the engine sees
 * only descriptors and calls. Consent model: servers exist ONLY because the
 * human wrote them into `.efferent/config.json`.
 */

export class McpError extends Schema.TaggedError<McpError>()("McpError", {
  server: Schema.String,
  message: Schema.String,
}) {}

export class McpToolDescriptor extends Schema.Class<McpToolDescriptor>("McpToolDescriptor")({
  server: Schema.String,
  name: Schema.String,
  description: Schema.optionalWith(Schema.String, { as: "Option" }),
  /** The server's inputSchema, verbatim JSON Schema — the provider sees it
   *  unchanged through the bridge's annotation override. */
  inputSchema: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
}) {}

export class McpCallOutcome extends Schema.Class<McpCallOutcome>("McpCallOutcome")({
  /** MCP's in-band failure flag — bridged to failure-as-data, never thrown. */
  isError: Schema.Boolean,
  /** structuredContent when the server sent it, else the text blocks joined. */
  result: Schema.Unknown,
}) {}

export class McpClient extends Context.Tag("@xandreed/engine/McpClient")<
  McpClient,
  {
    /** Aggregate across every configured server — best-effort: an
     *  unreachable server contributes nothing, never a failure. */
    readonly listTools: Effect.Effect<ReadonlyArray<McpToolDescriptor>>
    readonly callTool: (
      server: string,
      tool: string,
      args: unknown,
    ) => Effect.Effect<McpCallOutcome, McpError>
  }
>() {}
