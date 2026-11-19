import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import { globMatches, linesPage, listText, searchText, treePath } from "./review-tools.entity.functions.js"

describe("treePath", () => {
  test.each([
    ["src/index.ts", "src/index.ts"],
    ["./src/index.ts", "src/index.ts"],
    ["src/", "src"],
    ["a/.github/x.yml", "a/.github/x.yml"],
  ])("%j is %j", (raw, path) => {
    expect(treePath(raw)).toEqual(Result.succeed(path))
  })

  test.each(["", "/", "/etc/passwd", "../x", "src/../../x", "a/./b", ".git", ".git/config", "a/.GIT/HEAD", "a//b", "a\u0000b"])("%j is refused", (raw) => {
    expect(Result.isFailure(treePath(raw))).toBe(true)
  })
})

describe("globMatches", () => {
  test.each([
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/x/a.ts", false],
    ["src/**", "src/x/a.ts", true],
    ["src/**/*.ts", "src/a.ts", true],
    ["src/**/*.ts", "src/x/y/a.ts", true],
    ["src/**/*.ts", "src/x/y/a.tsx", false],
    ["**/AGENTS.md", "AGENTS.md", true],
    ["**/AGENTS.md", "packages/sdk/AGENTS.md", true],
    ["**/AGENTS.md", "packages/sdk/NOT-AGENTS.md", false],
    ["?.md", "a.md", true],
    ["?.md", "/.md", false],
    ["./src/*", "src/a", true],
    ["/src/*", "src/a", true],
    ["src", "src", true],
    ["src", "src/a.ts", false],
    ["*", "a/b", false],
    ["**", "a/b", true],
    [":(glob)odd/*", ":(glob)odd/a.ts", true],
  ] as const)("%j against %j is %j", (glob, path, matches) => {
    expect(globMatches(glob, path)).toBe(matches)
  })

  test("a glob of many stars over a long path answers at once", () => {
    const glob = `${"*a".repeat(90)}b`
    const path = "a".repeat(5_000)
    const started = performance.now()
    expect(globMatches(glob, path)).toBe(false)
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})

describe("the tools' answers, past their caps", () => {
  test("listText: at most 200 paths in code-unit order, then how many more and how to narrow", () => {
    const paths = Array.from({ length: 250 }, (_, at) => `src/f${String(at).padStart(3, "0")}.ts`).reverse()
    const lines = listText("src/*.ts", [...paths, "docs/x.md"]).split("\n")
    expect([lines.length, lines[0], lines[1], lines[200], lines[201]]).toEqual([202, "250 files match \"src/*.ts\"; the first 200:", "src/f000.ts", "src/f199.ts", "50 more: narrow the glob."])
  })

  test("searchText: a long line cut at 200 characters with a count, on one line", () => {
    const text = searchText("x", "src", [{ path: "src/a.ts", line: 3, text: `  ${"x".repeat(400)}  ` }])
    const [head, line] = text.split("\n")
    expect([head, line?.length, line?.endsWith(" [… 239 characters clipped]"), text.split("\n").length]).toEqual(["1 line holds \"x\" in src:", 200, true, 2])
  })

  test("linesPage: an empty file, and a long line clipped with a count", () => {
    expect(linesPage("a.txt", "", 1, 150)).toEqual(Result.succeed("a.txt is empty."))
    expect(linesPage("a.txt", `${"y".repeat(600)}\r\n`, 1, 150)).toEqual(Result.succeed(`a.txt: lines 1 to 1 of 1.\n1| ${"y".repeat(473)} [… 127 characters clipped]\nThis is the end of the file.`))
  })
})
