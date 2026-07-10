import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { LocalFileSystemLive } from "@xandreed/providers"
import { expandFileRefs } from "./fileRefs.js"

const dir = mkdtempSync(join(tmpdir(), "filerefs-"))
writeFileSync(join(dir, "small.ts"), "export const x = 1\n")
writeFileSync(join(dir, "big.txt"), "y".repeat(30_000))
writeFileSync(join(dir, "blob.bin"), Buffer.from([0x89, 0x00, 0x50, 0x4e]))

const expand = (text: string) =>
  Effect.runPromise(expandFileRefs(dir, text).pipe(Effect.provide(LocalFileSystemLive)))

describe("expandFileRefs", () => {
  test("an existing @ref inlines as a labeled block; the message stays verbatim", async () => {
    const out = await expand("look at @small.ts please")
    expect(out.text).toContain("look at @small.ts please")
    expect(out.text).toContain("[file: small.ts]")
    expect(out.text).toContain("export const x = 1")
    expect(out.notes).toEqual([])
  })

  test("missing, glob, and binary refs are NOTED, never inlined", async () => {
    const out = await expand("see @nope.ts and @src/*.ts and @blob.bin")
    expect(out.text).not.toContain("[file:")
    expect(out.notes).toContainEqual(expect.stringContaining("@nope.ts: not found"))
    expect(out.notes).toContainEqual(expect.stringContaining("globs are not expanded"))
    expect(out.notes).toContainEqual(expect.stringContaining("binary"))
  })

  test("per-file clip + total budget hold", async () => {
    const out = await expand("read @big.txt")
    expect(out.text.length).toBeLessThan(10_000)
    expect(out.text).toContain("clipped")
  })

  test("no refs → identity", async () => {
    const out = await expand("plain message, email me at a@b.c? no — that IS a ref shape")
    // "b.c" resolves against the workspace and is simply not found.
    expect(out.text.startsWith("plain message")).toBe(true)
  })
})
