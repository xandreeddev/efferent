import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { snapshotWorkspace } from "./tempWorkspace.js"

describe("snapshotWorkspace — hostile filesystems", () => {
  test("an unreadable directory is skipped, never fatal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "foundry-snap-"))
    writeFileSync(join(dir, "ok.ts"), "export {}")
    mkdirSync(join(dir, "pg-data"))
    writeFileSync(join(dir, "pg-data", "secret"), "x")
    chmodSync(join(dir, "pg-data"), 0o000)
    const snapshot = await Effect.runPromise(snapshotWorkspace(dir))
    chmodSync(join(dir, "pg-data"), 0o700)
    expect(snapshot.files.map(String)).toEqual(["ok.ts"])
  })

  test("skipped dirs are pruned before descent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "foundry-snap-"))
    mkdirSync(join(dir, "node_modules", "dep"), { recursive: true })
    writeFileSync(join(dir, "node_modules", "dep", "index.js"), "x")
    writeFileSync(join(dir, "keep.ts"), "export {}")
    const snapshot = await Effect.runPromise(snapshotWorkspace(dir))
    expect(snapshot.files.map(String)).toEqual(["keep.ts"])
  })
})
