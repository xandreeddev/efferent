import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import type { FilePath } from "../files/files.entity.js"
import { finderOf, globOf, matchesIn, repeatsChoice, shownLine } from "./search.entity.functions.js"

const keeps = (glob: string, paths: ReadonlyArray<string>) =>
  Result.match(globOf(glob), { onFailure: () => ["refused"], onSuccess: (keep) => paths.filter((path) => keep(path as FilePath)) })

describe("the search's rules", () => {
  test("a glob's characters other than * and ? are taken as they are, and ** may stand for no folder", () => {
    expect(keeps("a+b(1).ts", ["a+b(1).ts", "aab1.ts"])).toEqual(["a+b(1).ts"])
    expect(keeps("src/**/x.ts", ["src/x.ts", "src/a/b/x.ts", "srcx.ts"])).toEqual(["src/x.ts", "src/a/b/x.ts"])
    expect(keeps("*", ["a", "b/c"])).toEqual(["a", "b/c"])
    expect(keeps("", ["a"])).toEqual(["a"])
  })

  test("a repeated group that holds a choice or a quantifier is refused, and ordinary patterns pass", () => {
    const refusedOnes = ["(a|aa)+$", "(a|a)*b", "(\\w+\\s?)*$", "(x+x+)+y", "(a+)+", "(x*)*", "((ab)+)+", "(a+){2,}", "(?<w>a|b)*", "(a|b){2,5}", "(\\d+\\.){3}", "(?:a?b)+?"]
    const passing = ["foo|bar", "\\d+-\\d+", "(ab)+", "a{2,4}", "[(a|b)]+", "\\(a|b\\)+", "(a|b)?", "(a+){1}", "(a|b)", "^export (const|function)", "x*y+z?"]
    expect(refusedOnes.map((pattern) => [pattern, repeatsChoice(pattern)])).toEqual(refusedOnes.map((pattern) => [pattern, true]))
    expect(passing.map((pattern) => [pattern, repeatsChoice(pattern)])).toEqual(passing.map((pattern) => [pattern, false]))
  })

  test("a pattern the check refuses is refused before a line is read, with its reason", () => {
    expect(Result.match(finderOf({ pattern: "(a|aa)+$", regex: true }), { onFailure: (error) => error.reason, onSuccess: () => "compiled" })).toBe("RepeatedGroup")
    expect(Result.match(finderOf({ pattern: "(a|aa)+$" }), { onFailure: (error) => error.reason, onSuccess: () => "as written" })).toBe("as written")
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
