import { Effect, HashMap, Layer, Option, Scope, SynchronizedRef } from "effect"
import { McpCallOutcome, McpClient, McpError, McpToolDescriptor } from "@xandreed/engine"
import { readMcpServers } from "./config.js"
import { openStdioConnection } from "./stdioConnection.js"
import type { McpConnection } from "./stdioConnection.js"

/**
 * The MCP client adapter. Connections open LAZILY per server on first use
 * and memoize under the layer's Scope — a run that touches no MCP tool
 * spawns nothing. Handshake per connection: `initialize` →
 * `notifications/initialized`. `listTools` is best-effort across servers
 * (an unreachable one contributes nothing); `callTool` is strict per call.
 */

const PROTOCOL_VERSION = "2025-06-18"

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}

/** Text blocks joined; structuredContent wins when the server sends it. */
const outcomeOf = (result: unknown): McpCallOutcome => {
  const record = asRecord(result)
  const structured = record["structuredContent"]
  const content = Array.isArray(record["content"])
    ? (record["content"] as ReadonlyArray<unknown>)
        .map((part) => {
          const p = asRecord(part)
          return p["type"] === "text" && typeof p["text"] === "string" ? p["text"] : ""
        })
        .filter((text) => text.length > 0)
        .join("\n")
    : ""
  return new McpCallOutcome({
    isError: record["isError"] === true,
    result: structured !== undefined ? structured : content,
  })
}

export const McpClientLive = (cwd: string, home: string): Layer.Layer<McpClient> =>
  Layer.scoped(
    McpClient,
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const connectionsRef = yield* SynchronizedRef.make(HashMap.empty<string, McpConnection>())

      // modifyEffect SERIALIZES connects (the TsProjectCachedLive pattern):
      // two concurrent tool calls to the same server (tool concurrency is 4)
      // must never check-miss together and spawn the server process TWICE —
      // the loser's orphan would run until layer shutdown. Cross-server
      // connects serialize too; handshakes are fast, correctness first.
      const connect = (name: string): Effect.Effect<McpConnection, McpError> =>
        SynchronizedRef.modifyEffect(connectionsRef, (connections) =>
          Option.match(HashMap.get(connections, name), {
            onSome: (connection) => Effect.succeed([connection, connections] as const),
            onNone: () =>
              Effect.gen(function* () {
                const servers = yield* readMcpServers(cwd, home)
                const spec = Option.fromNullable(
                  servers.find(([serverName]) => serverName === name)?.[1],
                )
                if (Option.isNone(spec)) {
                  return yield* Effect.fail(
                    new McpError({
                      server: name,
                      message: "no such server in .efferent/config.json",
                    }),
                  )
                }
                const connection = yield* openStdioConnection(name, spec.value, cwd).pipe(
                  Scope.extend(scope),
                )
                yield* connection.request("initialize", {
                  protocolVersion: PROTOCOL_VERSION,
                  capabilities: {},
                  clientInfo: { name: "efferent", version: "1.0.0" },
                })
                yield* connection.notify("notifications/initialized", {})
                return [connection, HashMap.set(connections, name, connection)] as const
              }),
          }),
        )

      return {
        listTools: Effect.gen(function* () {
          const servers = yield* readMcpServers(cwd, home)
          const perServer = yield* Effect.forEach(servers, ([name]) =>
            connect(name).pipe(
              Effect.flatMap((connection) => connection.request("tools/list", {})),
              Effect.map((result) => {
                const tools = asRecord(result)["tools"]
                if (!Array.isArray(tools)) return []
                return tools.flatMap((raw) => {
                  const tool = asRecord(raw)
                  return typeof tool["name"] === "string"
                    ? [
                        new McpToolDescriptor({
                          server: name,
                          name: tool["name"],
                          description:
                            typeof tool["description"] === "string"
                              ? Option.some(tool["description"])
                              : Option.none(),
                          inputSchema: asRecord(tool["inputSchema"]),
                        }),
                      ]
                    : []
                })
              }),
              // Best-effort aggregate: a dead server contributes nothing.
              Effect.orElseSucceed(() => [] as ReadonlyArray<McpToolDescriptor>),
            ),
          )
          return perServer.flat()
        }),

        callTool: (server: string, tool: string, args: unknown) =>
          connect(server).pipe(
            Effect.flatMap((connection) =>
              connection.request("tools/call", { name: tool, arguments: args ?? {} }),
            ),
            Effect.map(outcomeOf),
          ),
      }
    }),
  )
