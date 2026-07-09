import { Tool, Toolkit } from "@effect/ai"
import { Context, Effect, Option, Schema } from "effect"
import { Failure } from "../domain/Failure.js"
import { McpClient } from "../ports/McpClient.js"
import type { McpToolDescriptor } from "../ports/McpClient.js"

/**
 * MCP descriptors → first-class toolkit entries, ZERO casts. Two Schema
 * annotations carry the trick:
 * - `jsonSchema: <server's inputSchema>` — a full-override annotation, so
 *   the PROVIDER sees the MCP server's real parameter schema;
 * - `parseOptions: { onExcessProperty: "preserve" }` on `Schema.Struct({})`
 *   — the tool-call params decode keeps every key, so the HANDLER receives
 *   the raw arguments and proxies them to `callTool` verbatim.
 * Results ride failure-as-data: an `isError` outcome (or a transport
 * failure) returns the shared `Failure` struct — the loop's corrective
 * machinery applies, never a dead turn.
 */

const OUTPUT_CAP_CHARS = 16_000
/** Providers commonly cap tool names at 64 chars. */
const NAME_CAP = 64

const clipResult = (value: unknown): unknown => {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? ""
  return text.length <= OUTPUT_CAP_CHARS
    ? value
    : `${text.slice(0, OUTPUT_CAP_CHARS)}\n[…clipped ${text.length - OUTPUT_CAP_CHARS} chars…]`
}

/** `mcp__<server>__<tool>`, hash-truncated past provider name limits. */
export const mcpToolName = (server: string, tool: string): string => {
  const full = `mcp__${server}__${tool}`
  if (full.length <= NAME_CAP) return full
  const hash = [...full]
    .reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7)
    .toString(36)
  return `${full.slice(0, NAME_CAP - hash.length - 1)}_${hash}`
}

/** The pass-through parameters schema: provider sees the REAL schema, the
 *  handler sees the raw args. */
const passthroughParameters = (inputSchema: Record<string, unknown>) =>
  Schema.Struct({}).annotations({
    jsonSchema: Object.keys(inputSchema).length > 0 ? inputSchema : { type: "object" },
    parseOptions: { onExcessProperty: "preserve" },
  })

export type McpBridgedTool = ReturnType<typeof toolFromDescriptor>

export const toolFromDescriptor = (descriptor: McpToolDescriptor) =>
  Tool.make(mcpToolName(descriptor.server, descriptor.name), {
    description: `${Option.getOrElse(
      descriptor.description,
      () => `The "${descriptor.name}" tool`,
    )} [external MCP tool from the "${descriptor.server}" server]`,
    success: Schema.Unknown,
    failure: Failure,
    failureMode: "return" as const,
  }).setParameters(passthroughParameters(descriptor.inputSchema))

export interface McpBridge {
  readonly toolkit: Toolkit.Toolkit<Record<string, McpBridgedTool>>
  /** Claims the merged toolkit's dynamic handler requirement; the real
   *  entries are keyed per tool name — with no MCP tools there are no
   *  lookups, so the empty context is honest. */
  readonly handlers: Context.Context<Tool.Handler<string>>
  readonly descriptors: ReadonlyArray<McpToolDescriptor>
}

export const emptyMcpBridge: McpBridge = {
  toolkit: Toolkit.make() as Toolkit.Toolkit<Record<string, McpBridgedTool>>,
  handlers: Context.empty() as Context.Context<Tool.Handler<string>>,
  descriptors: [],
}

/**
 * Snapshot the configured servers' tools into a toolkit + handler Context
 * (taken once per run — no `tools/list_changed` handling in v1). Handlers
 * close over the client, so the bridge's consumers need nothing further.
 */
export const buildMcpBridge: Effect.Effect<McpBridge, never, McpClient> =
  Effect.gen(function* () {
    const client = yield* McpClient
    const descriptors = yield* client.listTools
    if (descriptors.length === 0) return emptyMcpBridge

    const tools = descriptors.map(toolFromDescriptor)
    const toolkit = Toolkit.make(...tools) as Toolkit.Toolkit<Record<string, McpBridgedTool>>
    const handlerRecord = Object.fromEntries(
      descriptors.map((descriptor) => [
        mcpToolName(descriptor.server, descriptor.name),
        (args: unknown) =>
          client.callTool(descriptor.server, descriptor.name, args).pipe(
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
      ]),
    )
    const handlers = yield* toolkit.toContext(handlerRecord as never)
    return {
      toolkit,
      handlers: handlers as Context.Context<Tool.Handler<string>>,
      descriptors,
    }
  }).pipe(
    Effect.catchAll(() => Effect.succeed(emptyMcpBridge)),
  )
