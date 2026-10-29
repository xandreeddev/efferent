import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { fingerprintWorkspace, snapshotWorkspace, writeWorkspaceFile } from "./tempWorkspace.js"

describe("writeWorkspaceFile — a failed write", () => {
  test("is a WorkspaceError naming the file and keeping the filesystem's error as its cause", async () => {
    const dir = mkdtempSync(join(tmpdir(), "foundry-write-"))
    writeFileSync(join(dir, "blocker"), "a file where a directory should be")
    const error = await Effect.runPromise(Effect.flip(writeWorkspaceFile(dir, "blocker/src/inner.ts", "export {}")))
    expect(error._tag).toBe("WorkspaceError")
    expect(error.message).toBe("write of blocker/src/inner.ts failed")
    expect(error.cause).toHaveProperty("code", "ENOTDIR")
  })
})

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
    mkdirSync(join(dir, "src", "__pycache__"), { recursive: true })
    writeFileSync(join(dir, "src", "__pycache__", "mod.cpython-314.pyc"), "x")
    writeFileSync(join(dir, "keep.ts"), "export {}")
    const snapshot = await Effect.runPromise(snapshotWorkspace(dir))
    expect(snapshot.files.map(String)).toEqual(["keep.ts"])
  })
})

describe("fingerprintWorkspace — the movement oracle", () => {
  test("hidden DIRS are infrastructure (pruned); hidden FILES are real edits (kept)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "foundry-fp-"))
    writeFileSync(join(dir, "keep.ts"), "export {}")
    writeFileSync(join(dir, ".gitignore"), "zig-out/")
    mkdirSync(join(dir, ".local", "bin"), { recursive: true })
    writeFileSync(join(dir, ".local", "bin", "zig"), "#!/bin/sh")
    mkdirSync(join(dir, ".zig-cache"))
    writeFileSync(join(dir, ".zig-cache", "manifest"), "churn")
    const fingerprint = await Effect.runPromise(fingerprintWorkspace(dir))
    expect([...fingerprint.keys()].map(String).sort()).toEqual([".gitignore", "keep.ts"])
  })

  test("a rewrite moves the signature; an untouched file keeps it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "foundry-fp-"))
    writeFileSync(join(dir, "still.ts"), "export {}")
    writeFileSync(join(dir, "moved.ts"), "one")
    const before = await Effect.runPromise(fingerprintWorkspace(dir))
    // A heredoc-style rewrite: different content, no tool call anywhere.
    writeFileSync(join(dir, "moved.ts"), "one more line\n")
    const after = await Effect.runPromise(fingerprintWorkspace(dir))
    const still = [...before.keys()].find((key) => String(key) === "still.ts")!
    const moved = [...before.keys()].find((key) => String(key) === "moved.ts")!
    expect(after.get(still)).toBe(before.get(still)!)
    expect(after.get(moved)).not.toBe(before.get(moved)!)
  })
})
