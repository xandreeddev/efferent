import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import { compileGlob } from "./glob.entity.functions.js"
import type { GlobMatcher, GlobMatchOptions } from "./glob.entity.functions.js"

/** The compiled pattern; a refused one fails the test. */
const compiled = (pattern: string, options?: GlobMatchOptions): GlobMatcher => {
  const result = compileGlob(pattern, options)
  expect(Result.isSuccess(result) ? "compiled" : result.failure).toBe("compiled")
  return Result.getOrElse(result, (): GlobMatcher => ({ matches: () => false, descends: () => false }))
}
const matching = (pattern: string, paths: ReadonlyArray<string>, dot = false) => paths.filter(compiled(pattern, { dot }).matches)

describe("compileGlob", () => {
  test("* and ? stay within one segment; ** crosses any number, none included", () => {
    expect(matching("*.ts", ["a.ts", "src/a.ts", "a.tsx", ".ts"])).toEqual(["a.ts"])
    expect(matching("?.md", ["a.md", "ab.md", "/.md"])).toEqual(["a.md"])
    expect(matching("src/**/*.ts", ["src/a.ts", "src/x/y/b.ts", "src.ts", "lib/src/a.ts"])).toEqual(["src/a.ts", "src/x/y/b.ts"])
    expect(matching("**", ["a", "a/b", "a/b/c"])).toEqual(["a", "a/b", "a/b/c"])
    expect(matching("a/**/**/b", ["a/b", "a/x/b", "a/x/y/b"])).toEqual(["a/b", "a/x/b", "a/x/y/b"])
  })

  test("classes match one character, ranges and negation included; an unclosed one is literal", () => {
    expect(matching("[ab]*", ["apple", "banana", "cherry"])).toEqual(["apple", "banana"])
    expect(matching("v[0-9]", ["v1", "v9", "vx", "v10"])).toEqual(["v1", "v9"])
    expect(matching("[!a]*", ["apple", "banana"])).toEqual(["banana"])
    expect(matching("[^a]*", ["apple", "banana"])).toEqual(["banana"])
    expect(matching("[]]x", ["]x", "x"])).toEqual(["]x"])
    expect(matching("a[b", ["a[b", "ab"])).toEqual(["a[b"])
    expect(matching("[z-a]", ["[z-a]", "m"])).toEqual(["[z-a]"])
    expect(matching("[-a]x", ["-x", "ax", "bx"])).toEqual(["-x", "ax"])
    expect(matching("[a\\-z]", ["a", "-", "z", "m"])).toEqual(["a", "-", "z"])
  })

  test("braces expand, nested and across segments; one without a comma is literal", () => {
    expect(matching("*.{ts,tsx}", ["a.ts", "a.tsx", "a.js"])).toEqual(["a.ts", "a.tsx"])
    expect(matching("{src,test/{unit,e2e}}/*.ts", ["src/a.ts", "test/unit/b.ts", "test/e2e/c.ts", "test/d.ts"])).toEqual(["src/a.ts", "test/unit/b.ts", "test/e2e/c.ts"])
    expect(matching("{a}.md", ["{a}.md", "a.md"])).toEqual(["{a}.md"])
    expect(matching("{a,b", ["{a,b", "a"])).toEqual(["{a,b"])
  })

  test("a backslash makes the next character literal; other regular-expression syntax is literal", () => {
    expect(matching("\\*.md", ["*.md", "a.md"])).toEqual(["*.md"])
    expect(matching("\\{a,b\\}", ["{a,b}", "a"])).toEqual(["{a,b}"])
    expect(matching("a+(b)|c.$", ["a+(b)|c.$", "aab"])).toEqual(["a+(b)|c.$"])
  })

  test("dot entries match only with dot, or where the pattern spells the dot", () => {
    expect(matching("*", [".env", "env"])).toEqual(["env"])
    expect(matching("*", [".env", "env"], true)).toEqual([".env", "env"])
    expect(matching("**/*.ts", [".git/a.ts", "src/.cache/b.ts", "src/c.ts"])).toEqual(["src/c.ts"])
    expect(matching("**/*.ts", [".git/a.ts", "src/.cache/b.ts", "src/c.ts"], true)).toEqual([".git/a.ts", "src/.cache/b.ts", "src/c.ts"])
    expect(matching(".github/**/*.yml", [".github/workflows/ci.yml"])).toEqual([".github/workflows/ci.yml"])
    expect(matching("src/.*", ["src/.env", "src/env"])).toEqual(["src/.env"])
  })

  test("leading ./ and empty segments are ignored; UTF-8 names match by character", () => {
    expect(matching("./src//*.ts", ["src/a.ts"])).toEqual(["src/a.ts"])
    expect(matching("caf?.md", ["café.md", "cafe.md"])).toEqual(["café.md", "cafe.md"])
  })
})

describe("compileGlob descends", () => {
  test("only into directories that can hold a match", () => {
    const glob = compiled("src/{lib,bin}/**/*.ts")
    expect(["src", "src/lib", "src/lib/deep", "src/bin", "docs", "src/test", "src/lib/.cache"].filter(glob.descends))
      .toEqual(["src", "src/lib", "src/lib/deep", "src/bin"])
    expect(compiled("a/b").descends("a/b")).toBe(false)
    expect(compiled("*.ts").descends("src")).toBe(false)
    expect(compiled("**").descends(".git")).toBe(false)
    expect(compiled("**", { dot: true }).descends(".git")).toBe(true)
  })

  test("braces standing for up to 1024 patterns compile and match every one; more are refused, not cut short", () => {
    const braces = (count: number) => Array.from({ length: count }, () => "{a,b}").join("")
    const ten = compiled(braces(10))
    expect(["a".repeat(10), "b".repeat(10), "ab".repeat(5), "a".repeat(9)].filter(ten.matches)).toEqual(["a".repeat(10), "b".repeat(10), "ab".repeat(5)])
    const eleven = compileGlob(braces(11))
    expect(Result.isFailure(eleven) ? eleven.failure : "compiled").toBe("its braces stand for more than 1024 patterns")
    const twenty = compileGlob(braces(20))
    expect(Result.isFailure(twenty)).toBe(true)
  })
})
