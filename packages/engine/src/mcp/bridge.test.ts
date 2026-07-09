import { describe, expect, test } from "bun:test"
import { Tool } from "@effect/ai"
import { Effect, Layer, Option, Schema } from "effect"
import { McpCallOutcome, McpClient, McpError, McpToolDescriptor } from "../ports/McpClient.js"
import { buildMcpBridge, mcpToolName, toolFromDescriptor } from "./bridge.js"

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

describe("the MCP bridge", () => {
  test("the provider sees the server's REAL schema (jsonSchema override, pinned)", () => {
    const tool = toolFromDescriptor(descriptor)
    expect(tool.name).toBe("mcp__files__search")
    const json = Tool.getJsonSchema(tool)
    expect(JSON.stringify(json)).toContain('"query"')
    expect(JSON.stringify(json)).toContain('"required"')
  })

  test("param decode PRESERVES every key — the handler gets raw args", async () => {
    const tool = toolFromDescriptor(descriptor)
    const decoded = await Effect.runPromise(
      Schema.decodeUnknown(tool.parametersSchema)({ query: "x", nested: { deep: true } }),
    )
    expect(decoded).toEqual({ query: "x", nested: { deep: true } })
  })

  test("names truncate with a hash past 64 chars — stable and unique-ish", () => {
    const long = mcpToolName("a".repeat(40), "b".repeat(40))
    expect(long.length).toBeLessThanOrEqual(64)
    expect(long).toBe(mcpToolName("a".repeat(40), "b".repeat(40)))
    expect(long).not.toBe(mcpToolName("a".repeat(40), "c".repeat(40)))
  })

  test("buildMcpBridge: isError → failure-as-data; transport McpError mapped; ok clipped result", async () => {
    const client = Layer.succeed(McpClient, {
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
    const bridge = await Effect.runPromise(buildMcpBridge.pipe(Effect.provide(client)))
    expect(bridge.descriptors).toHaveLength(1)
    const handler = bridge.handlers.unsafeMap.get(
      "@effect/ai/Tool/mcp__files__search",
    ) as { readonly handler: (args: unknown) => Effect.Effect<unknown, unknown> }
    const ok = await Effect.runPromise(handler.handler({ query: "hi" }))
    expect(ok).toEqual({ hits: ["hi"] })
    const isError = await Effect.runPromise(
      handler.handler({ query: "boom" }).pipe(Effect.either),
    )
    expect(isError._tag).toBe("Left")
    expect(JSON.stringify(isError)).toContain("McpToolError")
    const transport = await Effect.runPromise(
      handler.handler({ query: "dead" }).pipe(Effect.either),
    )
    expect(JSON.stringify(transport)).toContain("McpTransportError")
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
