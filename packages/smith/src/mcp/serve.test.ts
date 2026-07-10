import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * The MCP server's protocol contract, over the REAL stdio wire: a spawned
 * `smith mcp` must handshake, list EXACTLY the read-only subset (the v1
 * guard — additions are a security decision), and serve a call.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..")

const rpc = (lines: ReadonlyArray<unknown>): string =>
  lines.map((line) => JSON.stringify(line)).join("\n") + "\n"

describe("smith mcp (stdio)", () => {
  test("handshake → read-only tool list → a served call; no mutation exposed", async () => {
    const ws = mkdtempSync(join(tmpdir(), "mcp-ws-"))
    writeFileSync(join(ws, "hello.txt"), "workspace says hi\n")
    const proc = Bun.spawn(
      ["bun", "packages/smith/src/main.ts", "mcp", "--cwd", ws],
      {
        cwd: REPO_ROOT,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      },
    )
    proc.stdin.write(
      rpc([
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "0" },
          },
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "read_file", arguments: { path: "hello.txt" } },
        },
      ]),
    )
    await proc.stdin.flush()

    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    // Read until the id-3 REPLY lands (the wire may interleave
    // notifications, so a line count is not a reply count).
    const collect = async (buffer: string): Promise<string> => {
      if (buffer.includes('"id":3') || buffer.includes('"id": 3')) return buffer
      const { done, value } = await reader.read()
      if (done || value === undefined) return buffer
      return collect(buffer + decoder.decode(value, { stream: true }))
    }
    const raw = await collect("")
    proc.kill()

    const replies = raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { id?: number; result?: unknown })
    const byId = new Map(replies.map((reply) => [reply.id, reply.result]))

    const init = byId.get(1) as { serverInfo: { name: string } }
    expect(init.serverInfo.name).toBe("smith-workspace")

    const tools = (byId.get(2) as { tools: ReadonlyArray<{ name: string }> }).tools
      .map((tool) => tool.name)
      .sort()
    // The v1 GUARD, pinned: exactly the read-only subset — a write tool
    // appearing here is a security regression, not a feature.
    expect(tools).toEqual(["glob", "grep", "load_skill", "ls", "read_file"])

    const call = JSON.stringify(byId.get(3))
    expect(call).toContain("workspace says hi")
  }, 30_000)
})
