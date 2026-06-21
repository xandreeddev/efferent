import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import {
  discoveryPath,
  readDiscovery,
  removeDiscovery,
  workspaceHash,
  writeDiscovery,
} from "./discovery.js"

describe("daemon discovery file", () => {
  let prev: string | undefined
  beforeAll(() => {
    prev = process.env.EFFERENT_HOME
    process.env.EFFERENT_HOME = mkdtempSync(join(tmpdir(), "eff-disco-"))
  })
  afterAll(() => {
    if (prev === undefined) delete process.env.EFFERENT_HOME
    else process.env.EFFERENT_HOME = prev
  })

  test("workspaceHash is stable per path and the path lives under EFFERENT_HOME", () => {
    expect(workspaceHash("/tmp/ws-a")).toBe(workspaceHash("/tmp/ws-a"))
    expect(workspaceHash("/tmp/ws-a")).not.toBe(workspaceHash("/tmp/ws-b"))
    expect(discoveryPath("/tmp/ws-a")).toContain(process.env.EFFERENT_HOME!)
    expect(discoveryPath("/tmp/ws-a").endsWith(`daemon-${workspaceHash("/tmp/ws-a")}.json`)).toBe(true)
  })

  test("write → read round-trips; remove clears it; absent reads undefined", async () => {
    const info = { port: 4567, pid: 999, version: "1.2.3", workspace: "/tmp/ws-disco" }
    await Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* readDiscovery(info.workspace)).toBeUndefined()
        yield* writeDiscovery(info)
        expect(existsSync(discoveryPath(info.workspace))).toBe(true)
        const read = yield* readDiscovery(info.workspace)
        expect(read).toEqual(info)
        yield* removeDiscovery(info.workspace)
        expect(yield* readDiscovery(info.workspace)).toBeUndefined()
      }),
    )
  })

  test("garbage file reads as undefined (treated absent)", async () => {
    const ws = "/tmp/ws-garbage"
    await Effect.runPromise(writeDiscovery({ port: 1, pid: 1, version: "x", workspace: ws }))
    // Corrupt it: a non-DiscoveryInfo JSON.
    const { writeFileSync } = await import("node:fs")
    writeFileSync(discoveryPath(ws), "{ not valid")
    expect(await Effect.runPromise(readDiscovery(ws))).toBeUndefined()
  })
})
