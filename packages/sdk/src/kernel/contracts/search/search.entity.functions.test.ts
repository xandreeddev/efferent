import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import type { FilePath } from "../files/files.entity.js"
import { finderOf, globOf, matchesIn, shownLine } from "./search.entity.functions.js"

const keeps = (glob: string, paths: ReadonlyArray<string>) =>
  Result.match(globOf(glob), { onFailure: () => ["refused"], onSuccess: (keep) => paths.filter((path) => keep(path as FilePath)) })

describe("the search's rules", () => {
  test("a glob's characters other than * and ? are taken as they are, and ** may stand for no folder", () => {
    expect(keeps("a+b(1).ts", ["a+b(1).ts", "aab1.ts"])).toEqual(["a+b(1).ts"])
    expect(keeps("src/**/x.ts", ["src/x.ts", "src/a/b/x.ts", "srcx.ts"])).toEqual(["src/x.ts", "src/a/b/x.ts"])
    expect(keeps("*", ["a", "b/c"])).toEqual(["a", "b/c"])
    expect(keeps("", ["a"])).toEqual(["a"])
  })

  test("a long line is cut around its match, never inside a character", () => {
    const line = `${"😀".repeat(150)}needle${"😀".repeat(150)}`
    const at = line.indexOf("needle")
    const shown = shownLine(line, at)
    expect(shown.length).toBeLessThanOrEqual(200)
    expect(shown).toContain("needle")
    expect(shown.includes("�")).toBe(false)
    expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(shown)).toBe(false)
  })

  test("a file's lines: a \\r before the line end is left out, a last line with no end is a line, and the column is the first match's", () => {
    const find = Result.getOrThrow(finderOf({ pattern: "ab" }))
    expect<unknown>(matchesIn("f" as FilePath, "ab ab\r\n\r\nxab", find)).toEqual([
      { path: "f", line: 1, column: 1, text: "ab ab" },
      { path: "f", line: 3, column: 2, text: "xab" },
    ])
  })
})
