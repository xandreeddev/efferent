import { Deferred, Effect, HashMap, Layer, Option, Scope, SynchronizedRef } from "effect"
import { McpCallOutcome, McpClient, McpError, McpToolDescriptor } from "@xandreed/core"
import { readMcpServers } from "./config.js"
import type { McpServerSpec } from "./config.js"
import { openStdioConnection } from "./stdioConnection.js"
import type { McpConnection } from "./stdioConnection.js"

/**
 * The MCP client adapter. A connection opens on a server's first use and
 * memoizes under the layer's Scope — and since the bridge asks `listTools`
 * at build (progressive disclosure needs the names), a run with configured
 * servers connects them all at start: CONCURRENTLY, each handshake bounded
 * by {@link HANDSHAKE_TIMEOUT_MS}, so one hung server delays nothing but
 * itself. Handshake per connection: `initialize` → `notifications/
 * initialized`. `listTools` is best-effort across servers (an unreachable
 * one contributes nothing); `callTool` is strict per call. A connection
 * whose child died (a write fails) is evicted, so the next call reconnects
 * instead of failing forever.
 */

const PROTOCOL_VERSION = "2025-06-18"
export const HANDSHAKE_TIMEOUT_MS = 15_000

/** A server slot as one caller sees it: the owner opens, the others await. */
interface Claim {
  readonly owner: boolean
  readonly deferred: Deferred.Deferred<McpConnection, McpError>
}
type Slots = HashMap.HashMap<string, Deferred.Deferred<McpConnection, McpError>>

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

export const McpClientLive = (cwd: string, home: string, configured?: ReadonlyArray<readonly [string, McpServerSpec]>): Layer.Layer<McpClient> =>
  Layer.scoped(
    McpClient,
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      // One SLOT per server: the claim is taken under the lock (fast), the
      // handshake runs OUTSIDE it. Two concurrent calls to the same server
      // still spawn it once (the loser awaits the winner's Deferred); two
      // different servers no longer wait for each other.
      const slotsRef = yield* SynchronizedRef.make<Slots>(HashMap.empty())
      const evict = (name: string) => SynchronizedRef.update(slotsRef, HashMap.remove(name))

      const open = (name: string): Effect.Effect<McpConnection, McpError> =>
        Effect.gen(function* () {
          const servers = yield* configured === undefined ? readMcpServers(cwd, home) : Effect.succeed(configured)
          const spec = Option.fromNullable(servers.find(([serverName]) => serverName === name)?.[1])
          if (Option.isNone(spec)) {
            return yield* Effect.fail(
              new McpError({ server: name, message: "no such server in .efferent/config.json" }),
            )
          }
          const connection = yield* openStdioConnection(name, spec.value, cwd).pipe(
            Scope.extend(scope),
          )
          yield* connection
            .request("initialize", {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "efferent", version: "1.0.0" },
            })
            .pipe(
              Effect.timeoutFail({
                duration: HANDSHAKE_TIMEOUT_MS,
                onTimeout: () =>
                  new McpError({
                    server: name,
                    message: `initialize did not answer within ${HANDSHAKE_TIMEOUT_MS}ms`,
                  }),
              }),
            )
          yield* connection.notify("notifications/initialized", {})
          return connection
        })

      const connect = (name: string): Effect.Effect<McpConnection, McpError> =>
        Effect.gen(function* () {
          const claim: Claim = yield* SynchronizedRef.modifyEffect(
            slotsRef,
            (slots: Slots): Effect.Effect<readonly [Claim, Slots]> =>
              Option.match(HashMap.get(slots, name), {
                onSome: (deferred): Effect.Effect<readonly [Claim, Slots]> =>
                  Effect.succeed([{ owner: false, deferred }, slots]),
                onNone: (): Effect.Effect<readonly [Claim, Slots]> =>
                  Effect.map(Deferred.make<McpConnection, McpError>(), (deferred) => [
                    { owner: true, deferred },
                    HashMap.set(slots, name, deferred),
                  ]),
              }),
          )
          if (!claim.owner) return yield* Deferred.await(claim.deferred)
          return yield* open(name).pipe(
            Effect.tap((connection) => Deferred.succeed(claim.deferred, connection)),
            // A failed open frees the slot: the next call retries the server
            // instead of inheriting a dead promise forever.
            Effect.tapError((error) =>
              Deferred.fail(claim.deferred, error).pipe(Effect.zipRight(evict(name))),
            ),
          )
        })

      /** A request whose child is gone (the write fails) evicts the slot. */
      const request = (name: string, method: string, params: unknown) =>
        connect(name).pipe(
          Effect.flatMap((connection) => connection.request(method, params)),
          Effect.tapError((error) =>
            error.message.startsWith("write failed") ? evict(name) : Effect.void,
          ),
        )

      return {
        listTools: Effect.gen(function* () {
          const servers = yield* configured === undefined ? readMcpServers(cwd, home) : Effect.succeed(configured)
          const perServer = yield* Effect.forEach(
            servers,
            ([name]) =>
            request(name, "tools/list", {}).pipe(
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
            // All servers at once — a hung one costs only its own timeout.
            { concurrency: "unbounded" },
          )
          return perServer.flat()
        }),

        callTool: (server: string, tool: string, args: unknown) =>
          request(server, "tools/call", { name: tool, arguments: args ?? {} }).pipe(
            Effect.map(outcomeOf),
          ),
      }
    }),
  )
