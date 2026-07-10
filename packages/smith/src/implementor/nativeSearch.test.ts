import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { nativeGlob, nativeGrep } from "./nativeSearch.js"

const dir = mkdtempSync(join(tmpdir(), "native-search-"))
mkdirSync(join(dir, "src"), { recursive: true })
mkdirSync(join(dir, "node_modules", "dep"), { recursive: true })
writeFileSync(join(dir, "src", "a.ts"), "const alpha = 1\nconst beta = 2\n")
writeFileSync(join(dir, "src", "b.md"), "alpha notes\n")
writeFileSync(join(dir, "node_modules", "dep", "x.ts"), "const alpha = 99\n")
writeFileSync(join(dir, "blob.bin"), "\0\0alpha\0")

describe("nativeGrep", () => {
  test("path:line:text matches, sorted walk, excluded trees and binaries skipped", async () => {
    const out = await Effect.runPromise(nativeGrep(dir, "alpha"))
    const lines = out.matches.split("\n")
    expect(lines).toEqual(["src/a.ts:1:const alpha = 1", "src/b.md:1:alpha notes"])
    expect(out.truncated).toBe(false)
  })

  test("regex syntax works; a bad pattern is failure-as-data", async () => {
    const out = await Effect.runPromise(nativeGrep(dir, "al(pha|so)"))
    expect(out.matches).toContain("src/a.ts:1")
    const bad = await Effect.runPromiseExit(nativeGrep(dir, "al(pha"))
    expect(bad._tag).toBe("Failure")
  })

  test("the 200-match cap reports truncated", async () => {
    const big = mkdtempSync(join(tmpdir(), "native-cap-"))
    writeFileSync(join(big, "many.txt"), Array.from({ length: 300 }, () => "hit").join("\n"))
    const out = await Effect.runPromise(nativeGrep(big, "hit"))
    expect(out.matches.split("\n")).toHaveLength(200)
    expect(out.truncated).toBe(true)
  })
})

describe("nativeGlob", () => {
  test("file-NAME matching (find -name parity), absolute output paths", async () => {
    const out = await Effect.runPromise(nativeGlob(dir, "*.ts"))
    expect(out.paths).toEqual([join(dir, "src", "a.ts")])
    const md = await Effect.runPromise(nativeGlob(dir, "b.*"))
    expect(md.paths).toEqual([join(dir, "src", "b.md")])
  })
})
