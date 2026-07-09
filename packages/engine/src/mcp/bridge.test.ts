import { describe, expect, test } from "bun:test"
import { Tool } from "@effect/ai"
import { Effect, Layer, Option, Schema } from "effect"
import { McpCallOutcome, McpClient, McpError, McpToolDescriptor } from "../ports/McpClient.js"
import { buildMcpBridge, McpCall } from "./bridge.js"

const descriptor = new McpToolDescriptor({
  server: "files",
  name: "search",
  description: Option.some("Search the indexed corpus."),
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "number" } },
    required: ["query"],
  },
})

const scriptedClient = Layer.succeed(McpClient, {
  listTools: Effect.succeed([descriptor]),
  callTool: (_server, _tool, args) => {
    const query = (args as { readonly query?: string }).query ?? ""
    return query === "boom"
      ? Effect.succeed(new McpCallOutcome({ isError: true, result: "index unavailable" }))
      : query === "dead"
        ? Effect.fail(new McpError({ server: "files", message: "socket closed" }))
        : Effect.succeed(new McpCallOutcome({ isError: false, result: { hits: [query] } }))
  },
})

const handlerOf = async (name: string) => {
  const bridge = await Effect.runPromise(buildMcpBridge.pipe(Effect.provide(scriptedClient)))
  return bridge.handlers.unsafeMap.get(`@effect/ai/Tool/${name}`) as {
    readonly handler: (args: unknown) => Effect.Effect<unknown, unknown>
  }
}

describe("the MCP bridge — progressive disclosure", () => {
  test("only TWO tools regardless of server tool count; descriptors carry the listing", async () => {
    const bridge = await Effect.runPromise(buildMcpBridge.pipe(Effect.provide(scriptedClient)))
    expect(Object.keys(bridge.toolkit.tools).sort()).toEqual(["mcp_call", "mcp_describe"])
    expect(bridge.descriptors).toHaveLength(1)
    // mcp_call's args are an OPEN object — the model shapes them from describe.
    const json = Tool.getJsonSchema(McpCall)
    expect(JSON.stringify(json)).toContain('"args"')
  })

  test("mcp_describe returns the tool's real input schema; unknown tool → failure-as-data", async () => {
    const describe = await handlerOf("mcp_describe")
    const ok = await Effect.runPromise(describe.handler({ server: "files", tool: "search" }))
    expect(ok).toMatchObject({
      server: "files",
      tool: "search",
      description: "Search the indexed corpus.",
    })
    expect(JSON.stringify(ok)).toContain('"required"')
    const miss = await Effect.runPromise(
      describe.handler({ server: "files", tool: "nope" }).pipe(Effect.either),
    )
    expect(miss._tag).toBe("Left")
    expect(JSON.stringify(miss)).toContain("UnknownMcpTool")
  })

  test("mcp_call: raw args reach the server; isError, transport, and unknown all fail as data", async () => {
    const call = await handlerOf("mcp_call")
    const ok = await Effect.runPromise(
      call.handler({ server: "files", tool: "search", args: { query: "hi", nested: { deep: true } } }),
    )
    expect(ok).toEqual({ hits: ["hi"] })
    const isError = await Effect.runPromise(
      call.handler({ server: "files", tool: "search", args: { query: "boom" } }).pipe(Effect.either),
    )
    expect(JSON.stringify(isError)).toContain("McpToolError")
    const transport = await Effect.runPromise(
      call.handler({ server: "files", tool: "search", args: { query: "dead" } }).pipe(Effect.either),
    )
    expect(JSON.stringify(transport)).toContain("McpTransportError")
    const unknown = await Effect.runPromise(
      call.handler({ server: "files", tool: "ghost", args: {} }).pipe(Effect.either),
    )
    expect(JSON.stringify(unknown)).toContain("UnknownMcpTool")
  })

  test("mcp_call's args decode PRESERVES nested keys — the server gets them verbatim", async () => {
    const decoded = await Effect.runPromise(
      Schema.decodeUnknown(McpCall.parametersSchema)({
        server: "files",
        tool: "search",
        args: { query: "x", nested: { deep: true } },
      }),
    )
    expect(decoded).toEqual({ server: "files", tool: "search", args: { query: "x", nested: { deep: true } } })
  })

  test("no servers → the empty bridge (no toolkit entries, no descriptors)", async () => {
    const client = Layer.succeed(McpClient, {
      listTools: Effect.succeed([]),
      callTool: () => Effect.fail(new McpError({ server: "x", message: "unused" })),
    })
    const bridge = await Effect.runPromise(buildMcpBridge.pipe(Effect.provide(client)))
    expect(bridge.descriptors).toEqual([])
    expect(Object.keys(bridge.toolkit.tools)).toEqual([])
  })
})
