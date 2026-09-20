import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either, Layer, Option } from "effect"
import { Shell } from "@xandreed/core"
import { LocalFileSystemLive } from "@xandreed/plugin-tools-local"
import { assembleContext, bundleSummary, fingerprintOf } from "./assemble.js"
import { emptyContextSet, parsePinRef, withBudget, withPin } from "./context-set.entity.functions.js"
import type { ContextSet } from "./context-set.entity.js"

const pin = (raw: string) => Either.getOrThrow(parsePinRef(raw))
const setOf = (...refs: ReadonlyArray<string>): ContextSet =>
  refs.reduce((set, ref) => withPin(set, pin(ref)), emptyContextSet)

/** A scripted Shell: records every command, answers by prefix. */
const scriptedShell = (calls: string[], answer: (command: string) => string) =>
  Layer.succeed(Shell, {
    exec: (command: string) =>
      Effect.sync(() => {
        calls.push(command)
        return { stdout: answer(command), stderr: "", exitCode: 0 }
      }),
  })

const workspace = () => {
  const cwd = mkdtempSync(join(tmpdir(), "smith-assemble-"))
  mkdirSync(join(cwd, "src"), { recursive: true })
  mkdirSync(join(cwd, ".efferent", "specs"), { recursive: true })
  writeFileSync(join(cwd, "src", "a.ts"), "export const a = 1\n")
  writeFileSync(join(cwd, "src", "b.ts"), "export const b = 2\n")
  writeFileSync(join(cwd, "src", "blob.bin"), Buffer.from([0x00, 0x01, 0x02]))
  writeFileSync(join(cwd, "big.txt"), "x".repeat(9_000))
  writeFileSync(
    join(cwd, ".efferent", "specs", "stats.md"),
    [
      "---",
      "slug: stats",
      "status: locked",
      "created: 2026-09-04T00:00:00.000Z",
      "locked: 2026-09-04T00:00:00.000Z",
      "maxAttempts: 3",
      "budgetMinutes: 15",
      "---",
      "",
      "# Goal",
      "",
      "A stats module with tests.",
      "",
      "## Acceptance",
      "",
      "- bun test exits 0",
      "",
    ].join("\n"),
  )
  return cwd
}

const run = <A>(cwd: string, calls: string[], effect: Effect.Effect<A, never, Shell | import("@xandreed/core").FileSystem>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(LocalFileSystemLive),
      Effect.provide(scriptedShell(calls, (c) => (c.startsWith("git diff") ? "diff --git a/x b/x\n+1\n" : `ran: ${c}`))),
    ),
  ).finally(() => rmSync(cwd, { recursive: true, force: true }))

describe("context assembly — deterministic, bounded, readable back", () => {
  test("every pin kind resolves to a block with a status; the prompt block lists what made it in", async () => {
    const cwd = workspace()
    const calls: string[] = []
    const set = setOf(
      "src/a.ts",
      "src/",
      "*.ts",
      "note: keep the API stable",
      "spec:stats",
      "run:deadbeef",
      "missing.ts",
      "src/blob.bin",
      "diff",
      "cmd: bun test",
    )
    const bundle = await run(cwd, calls, assembleContext(cwd, set))
    expect(bundle.blocks.map((b) => `${b.kind}:${b.status}`)).toEqual([
      "file:included",
      "dir:included",
      "glob:included",
      "note:included",
      "spec:included",
      "run:missing",
      "file:missing",
      "file:missing",
      "diff:included",
      "cmd:included",
    ])
    const text = Option.getOrThrow(bundle.text)
    expect(text).toContain("## Context selected by the human (7 sources")
    expect(text).toContain("### src/a.ts (file)\nexport const a = 1")
    expect(text).toContain("### src/ (dir)\n- a.ts\n- b.ts\n- blob.bin")
    expect(text).toContain("[file: src/a.ts]")
    expect(text).toContain("[file: src/b.ts]")
    expect(text).not.toContain("blob.bin]")
    expect(text).toContain("Reference spec stats (locked)")
    expect(text).toContain("$ git diff (exit 0)\ndiff --git")
    expect(text).toContain("$ bun test (exit 0)\nran: bun test")
    expect(calls).toEqual(["git diff", "bun test"])
    expect(bundleSummary(bundle)).toContain("run:deadbeef missing")
    expect(bundle.totalChars).toBeGreaterThan(0)
  })

  test("a file that reads as a directory lists instead; a big file is clipped, never silently cut", async () => {
    const cwd = workspace()
    const bundle = await run(cwd, [], assembleContext(cwd, setOf("src", "big.txt")))
    expect(bundle.blocks[0]?.status).toBe("included")
    expect(bundle.blocks[0]?.note).toEqual(Option.some("a directory — listed"))
    expect(bundle.blocks[1]?.status).toBe("clipped")
    expect(Option.getOrThrow(bundle.blocks[1]?.text ?? Option.none())).toContain("[…clipped at 8000 chars…]")
  })

  test("the budget skips whole blocks in pin order — the model never reads half a file as whole", async () => {
    const cwd = workspace()
    const set = withBudget(setOf("note: first", "big.txt", "note: last"), 1_000)
    const bundle = await run(cwd, [], assembleContext(cwd, set))
    expect(bundle.blocks.map((b) => b.status)).toEqual(["included", "skipped", "included"])
    expect(bundle.blocks[1]?.note).toEqual(Option.some("over the 1000-char budget"))
    const text = Option.getOrThrow(bundle.text)
    expect(text).toContain("note: first")
    expect(text).toContain("note: last")
    expect(text).not.toContain("xxxxxxxx")
  })

  test("execute:false defers the shell-backed pins — a dashboard refresh never runs the human's commands", async () => {
    const cwd = workspace()
    const calls: string[] = []
    const bundle = await run(cwd, calls, assembleContext(cwd, setOf("diff:main", "cmd: rm -rf /"), { execute: false }))
    expect(bundle.blocks.map((b) => b.status)).toEqual(["deferred", "deferred"])
    expect(calls).toEqual([])
    expect(Option.isNone(bundle.text)).toBe(true)
  })

  test("a pin switched off contributes nothing; the fingerprint follows the content", async () => {
    const cwd = workspace()
    const base = setOf("src/a.ts", "note: hi")
    const off = { ...base, pins: base.pins.map((p, i) => (i === 1 ? { ...p, on: false } : p)) } as ContextSet
    const [a, b, c] = await Promise.all([
      Effect.runPromise(assembleContext(cwd, base).pipe(Effect.provide(LocalFileSystemLive), Effect.provide(scriptedShell([], () => "")))),
      Effect.runPromise(assembleContext(cwd, base).pipe(Effect.provide(LocalFileSystemLive), Effect.provide(scriptedShell([], () => "")))),
      Effect.runPromise(assembleContext(cwd, off).pipe(Effect.provide(LocalFileSystemLive), Effect.provide(scriptedShell([], () => "")))),
    ])
    rmSync(cwd, { recursive: true, force: true })
    expect(a.fingerprint).toBe(b.fingerprint)
    expect(c.fingerprint).not.toBe(a.fingerprint)
    expect(c.blocks[1]?.status).toBe("off")
    expect(fingerprintOf("")).toBe("811c9dc5")
  })
})
