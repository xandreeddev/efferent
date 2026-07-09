import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { McpClient } from "@xandreed/engine"
import { readMcpServers } from "./config.js"
import { McpClientLive } from "./mcpClientLive.js"

/** A canned MCP server: NDJSON JSON-RPC over stdio, one echo tool. */
const CANNED_SERVER = `
const respond = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n")
process.stdin.setEncoding("utf-8")
const state = { buffer: "" }
process.stdin.on("data", (chunk) => {
  state.buffer += chunk
  const lines = state.buffer.split("\\n")
  state.buffer = lines.pop() ?? ""
  for (const line of lines) {
    if (line.trim().length === 0) continue
    const msg = JSON.parse(line)
    if (msg.method === "initialize") {
      respond({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "canned", version: "1" } } })
    } else if (msg.method === "tools/list") {
      respond({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "Echo the input back.", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }] } })
    } else if (msg.method === "tools/call") {
      const value = msg.params?.arguments?.value ?? ""
      if (value === "boom") {
        respond({ jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: "echo exploded" }] } })
      } else {
        respond({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo: " + value }] } })
      }
    }
  }
})
`

const seedWorkspace = (): string => {
  const cwd = mkdtempSync(join(tmpdir(), "mcp-ws-"))
  const server = join(cwd, "server.mjs")
  writeFileSync(server, CANNED_SERVER)
  mkdirSync(join(cwd, ".efferent"), { recursive: true })
  writeFileSync(
    join(cwd, ".efferent", "config.json"),
    JSON.stringify({ mcpServers: { canned: { command: "bun", args: [server] } } }),
  )
  return cwd
}

describe("readMcpServers", () => {
  test("local overrides global per name; malformed entries drop; missing files = empty", async () => {
    const home = mkdtempSync(join(tmpdir(), "mcp-home-"))
    const cwd = mkdtempSync(join(tmpdir(), "mcp-cwd-"))
    mkdirSync(join(home, ".efferent"), { recursive: true })
    mkdirSync(join(cwd, ".efferent"), { recursive: true })
    writeFileSync(
      join(home, ".efferent", "config.json"),
      JSON.stringify({
        mcpServers: {
          shared: { command: "global-cmd" },
          broken: { notCommand: true },
          globalOnly: { command: "g" },
        },
      }),
    )
    writeFileSync(
      join(cwd, ".efferent", "config.json"),
      JSON.stringify({ mcpServers: { shared: { command: "local-cmd", args: ["-x"] } } }),
    )
    const servers = await Effect.runPromise(readMcpServers(cwd, home))
    const byName = new Map(servers)
    expect(byName.get("shared")?.command).toBe("local-cmd")
    expect(byName.get("globalOnly")?.command).toBe("g")
    expect(byName.has("broken")).toBe(false)
    expect(await Effect.runPromise(readMcpServers("/nope", "/nada"))).toEqual([])
  })
})

describe("McpClientLive against a canned stdio server", () => {
  test("handshake → list → call (ok and isError); scope close kills the child", async () => {
    const cwd = seedWorkspace()
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* McpClient
          const tools = yield* client.listTools
          const ok = yield* client.callTool("canned", "echo", { value: "hello" })
          const bad = yield* client.callTool("canned", "echo", { value: "boom" })
          const unknown = yield* client
            .callTool("nope", "echo", {})
            .pipe(Effect.either)
          return { tools, ok, bad, unknown }
        }).pipe(Effect.provide(McpClientLive(cwd, "/nonexistent-home"))),
      ),
    )
    expect(result.tools).toHaveLength(1)
    expect(result.tools[0]?.name).toBe("echo")
    expect(Option.getOrThrow(result.tools[0]!.description)).toContain("Echo")
    expect(result.tools[0]?.inputSchema["required"]).toEqual(["value"])
    expect(result.ok.isError).toBe(false)
    expect(result.ok.result).toBe("echo: hello")
    expect(result.bad.isError).toBe(true)
    expect(result.bad.result).toBe("echo exploded")
    expect(result.unknown._tag).toBe("Left")
    expect(JSON.stringify(result.unknown)).toContain("no such server")
  })
})
