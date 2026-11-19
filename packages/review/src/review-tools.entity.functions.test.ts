import { describe, expect, test } from "bun:test"
import { Option, Result } from "effect"
import type { FileDiff } from "./diff.entity.js"
import { diffPage, globMatches, linesPage, listText, patternRefusal, searchText, treePath } from "./review-tools.entity.functions.js"

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
    const text = searchText("x", "src", [{ path: "src/a.ts", line: 3, text: `  ${"x".repeat(400)}  ` }], false)
    const [head, line] = text.split("\n")
    expect([head, line?.length, line?.endsWith(" [… 239 characters clipped]"), text.split("\n").length]).toEqual(["1 line holds \"x\" in src:", 200, true, 2])
  })

  test("patternRefusal: an empty pattern, a NUL, one too long", () => {
    expect([patternRefusal(""), patternRefusal("a\u0000b"), patternRefusal("p".repeat(301)), patternRefusal("ok")]).toEqual([
      Result.fail("The pattern is empty: give the text to search for."),
      Result.fail("The pattern holds a NUL character, which no line of text holds: give the text to search for."),
      Result.fail("The pattern has 301 characters; give at most 300."),
      Result.succeed("ok"),
    ])
  })

  test("linesPage: an empty file, and a long line clipped with a count", () => {
    expect(linesPage("a.txt", "", 1, 150)).toEqual(Result.succeed("a.txt is empty."))
    expect(linesPage("a.txt", `${"y".repeat(600)}\r\n`, 1, 150)).toEqual(Result.succeed(`a.txt: lines 1 to 1 of 1.\n1| ${"y".repeat(473)} [… 127 characters clipped]\nThis is the end of the file.`))
  })

  test("linesPage: lines past 30,000 characters wait for the next call", () => {
    const text = Array.from({ length: 150 }, () => "z".repeat(499)).join("\n")
    const page = Result.getOrThrow(linesPage("wide.ts", text, 1, 150)).split("\n")
    // Each numbered line is 504 characters with its line feed ("  1| " and 499): 59 fit in 30,000.
    expect([page[0], page.length, page.at(-1)]).toEqual(["wide.ts: lines 1 to 59 of 150.", 61, "Lines 60 to 150 follow: call readLines with from 60 to read on."])
  })

  test("diffPage: a long line cut at 500 characters with a count, and a page cut at 30,000 characters", () => {
    const line = (at: number, text: string) => ({ _tag: "Added" as const, line: at, text })
    const file = (lines: ReadonlyArray<ReturnType<typeof line>>): FileDiff => ({
      path: "dist/app.min.js", oldPath: Option.none(), change: "added", modeChange: Option.none(), binary: false, additions: lines.length, deletions: 0,
      hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: lines.length, section: "", lines }],
    })
    expect(diffPage([file([line(1, "m".repeat(3_000_000))])], "dist/app.min.js", 1)).toEqual(Result.succeed([
      "The diff of dist/app.min.js, page 1 of 1:",
      "File: dist/app.min.js (added, +1 -0)",
      "@@",
      `1 + ${"m".repeat(465)} [… 2999535 characters clipped]`,
      "This is the end of this file's diff.",
    ].join("\n")))
    const wide = Result.getOrThrow(diffPage([file(Array.from({ length: 140 }, (_, at) => line(at + 1, "w".repeat(600))))], "dist/app.min.js", 1)).split("\n")
    // The header, "@@" and 59 lines of 500 characters fit in 30,000; the title and the closing line come around them.
    expect([wide[0], wide.length, wide.at(-1), wide.join("\n").length <= 30_000 + 200]).toEqual(["The diff of dist/app.min.js, page 1 of 3:", 63, "Call readDiff with page 2 for the rest.", true])
  })
})
