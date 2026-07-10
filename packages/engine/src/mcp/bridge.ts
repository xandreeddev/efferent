import { Tool, Toolkit } from "@effect/ai"
import { Context, Effect, Option, Schema } from "effect"
import { Failure } from "../domain/Failure.js"
import { McpClient } from "../ports/McpClient.js"
import type { McpToolDescriptor } from "../ports/McpClient.js"

/**
 * MCP servers → the agent's toolkit by PROGRESSIVE DISCLOSURE, the same
 * three-tier shape the workspace skills use. However many tools the
 * configured servers expose, the model carries a CONSTANT two-tool cost:
 *
 *   tier 1 — the caller lists `server/tool — description` in the system
 *            prompt (from `bridge.descriptors`); no schemas, just names.
 *   tier 2 — `mcp_describe{server, tool}` returns ONE tool's real input
 *            schema, on demand, when the task matches it.
 *   tier 3 — `mcp_call{server, tool, args}` invokes it.
 *
 * The alternative — registering every server tool as its own typed entry —
 * puts every schema in every request; a handful of large servers (GitHub,
 * Playwright) is real weight on each turn. The trade is one extra round-trip
 * (describe → call) and looser arg validation: `mcp_call` takes an open
 * object, so a malformed call surfaces at call time as failure-as-data
 * rather than being rejected by the provider's schema check.
 *
 * Results ride failure-as-data throughout: an `isError` outcome, a transport
 * failure, or an unknown tool returns the shared `Failure` struct — the
 * loop's corrective machinery applies, never a dead turn.
 */

const OUTPUT_CAP_CHARS = 16_000
/** A single tool's arguments — an open object; the model shapes it from the
 *  schema `mcp_describe` handed back. */
const McpArgs = Schema.Record({ key: Schema.String, value: Schema.Unknown })

const clipResult = (value: unknown): unknown => {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? ""
  return text.length <= OUTPUT_CAP_CHARS
    ? value
    : `${text.slice(0, OUTPUT_CAP_CHARS)}\n[…clipped ${text.length - OUTPUT_CAP_CHARS} chars…]`
}

export const McpDescribe = Tool.make("mcp_describe", {
  description:
    "Reveal ONE external MCP tool's parameters. Pass the server + tool exactly as listed under 'External MCP tools'. Returns {server, tool, description, inputSchema} — the JSON Schema of the arguments mcp_call expects. Call this BEFORE mcp_call the first time you use a tool.",
  parameters: {
    server: Schema.String.annotations({ description: "The server name, as listed." }),
    tool: Schema.String.annotations({ description: "The tool name, as listed." }),
  },
  success: Schema.Struct({
    server: Schema.String,
    tool: Schema.String,
    description: Schema.String,
    inputSchema: Schema.Unknown,
  }),
  failure: Failure,
  failureMode: "return",
})

export const McpCall = Tool.make("mcp_call", {
  description:
    "Invoke an external MCP tool. Pass server + tool (as listed) and args as a JSON object matching the schema mcp_describe returned. A tool-level failure comes back as data (read it and adapt), not a dead turn. Returns the tool's result (clipped past 16k chars).",
  parameters: {
    server: Schema.String.annotations({ description: "The server name, as listed." }),
    tool: Schema.String.annotations({ description: "The tool name, as listed." }),
    args: McpArgs.annotations({
      description: "The tool's arguments as a JSON object (see mcp_describe); {} if it takes none.",
    }),
  },
  success: Schema.Unknown,
  failure: Failure,
  failureMode: "return",
})

/** The bridge's toolkit is the fixed describe/call pair, but typed loosely
 *  (`Tool.Any`) so the populated toolkit and the empty one share one shape. */
export type McpBridgedTool = Tool.Any

export interface McpBridge {
  readonly toolkit: Toolkit.Toolkit<Record<string, McpBridgedTool>>
  /** The two tools' handlers, closed over the client + descriptor snapshot. */
  readonly handlers: Context.Context<Tool.Handler<string>>
  /** Every configured tool, for the tier-1 prompt listing (names only). */
  readonly descriptors: ReadonlyArray<McpToolDescriptor>
}

export const emptyMcpBridge: McpBridge = {
  toolkit: Toolkit.make() as Toolkit.Toolkit<Record<string, McpBridgedTool>>,
  handlers: Context.empty() as Context.Context<Tool.Handler<string>>,
  descriptors: [],
}

/**
 * Snapshot the configured servers' tools into the fixed describe/call toolkit
 * (taken once per run — no `tools/list_changed` handling in v1). No servers,
 * or no tools across them, yields the empty bridge (no tool cost at all).
 */
export const buildMcpBridge: Effect.Effect<McpBridge, never, McpClient> =
  Effect.gen(function* () {
    const client = yield* McpClient
    const descriptors = yield* client.listTools
    if (descriptors.length === 0) return emptyMcpBridge

    const find = (server: string, tool: string): Option.Option<McpToolDescriptor> =>
      Option.fromNullable(
        descriptors.find((d) => d.server === server && d.name === tool),
      )

    // Spread an array (not a fixed tuple) so the toolkit is Record-shaped —
    // the same shape `emptyMcpBridge` carries, so both satisfy `McpBridge`.
    const tools: ReadonlyArray<McpBridgedTool> = [McpDescribe, McpCall]
    const toolkit = Toolkit.make(...tools) as Toolkit.Toolkit<Record<string, McpBridgedTool>>
    const handlerRecord = {
      mcp_describe: (params: { readonly server: string; readonly tool: string }) =>
        Option.match(find(params.server, params.tool), {
          onNone: () =>
            Effect.fail({
              error: "UnknownMcpTool",
              message: `no MCP tool "${params.tool}" on server "${params.server}" — use one listed under 'External MCP tools'`,
            }),
          onSome: (descriptor) =>
            Effect.succeed({
              server: descriptor.server,
              tool: descriptor.name,
              description: Option.getOrElse(descriptor.description, () => ""),
              inputSchema: descriptor.inputSchema,
            }),
        }),
      mcp_call: (params: {
        readonly server: string
        readonly tool: string
        readonly args: Record<string, unknown>
      }) =>
        Option.isNone(find(params.server, params.tool))
          ? Effect.fail({
              error: "UnknownMcpTool",
              message: `no MCP tool "${params.tool}" on server "${params.server}" — use one listed under 'External MCP tools'`,
            })
          : client.callTool(params.server, params.tool, params.args).pipe(
              Effect.flatMap((outcome) =>
                outcome.isError
                  ? Effect.fail({
                      error: "McpToolError",
                      message:
                        typeof outcome.result === "string"
                          ? outcome.result.slice(0, 2_000)
                          : JSON.stringify(outcome.result).slice(0, 2_000),
                    })
                  : Effect.succeed(clipResult(outcome.result)),
              ),
              Effect.catchTag("McpError", (error) =>
                Effect.fail({ error: "McpTransportError", message: error.message }),
              ),
            ),
    }
    const handlers = yield* toolkit.toContext(handlerRecord as never)
    return {
      toolkit,
      handlers: handlers as Context.Context<Tool.Handler<string>>,
      descriptors,
    }
  }).pipe(
    // Degrade to NO MCP tools rather than killing the run — but never
    // silently: a misconfigured server otherwise reads as "my tools
    // vanished" with zero signal (the sandboxedShell contract: the warning
    // IS the contract).
    Effect.catchAllCause((cause) =>
      Effect.logWarning(`MCP bridge unavailable — continuing without MCP tools: ${cause}`).pipe(
        Effect.as(emptyMcpBridge),
      ),
    ),
  )
