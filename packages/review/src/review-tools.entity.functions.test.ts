import { describe, expect, test } from "bun:test"
import { Option, Result } from "effect"
import type { FileDiff } from "./diff.entity.js"
import { diffPage, globMatches, keptReport, keptVerdict, linesPage, listText, patternRefusal, searchText, treePath, wholeLinesWithin, withEvidence } from "./review-tools.entity.functions.js"

describe("what a report and a verdict keep: cut, never refused", () => {
  test.each([
    ["a quote that fits is itself", "total += value", 40, "total += value"],
    ["one exactly at the limit is itself", "aaaa\nbbbbb", 10, "aaaa\nbbbbb"],
    ["past it, its first whole lines that fit together", "aaaa\nbbbb\ncccc", 10, "aaaa\nbbbb"],
    ["a line that would not fit whole is left out, never cut in half", "aaaa\nbbbbbb\nc", 10, "aaaa"],
    ["a first line over the limit alone is cut with clipTo's marker", `${"x".repeat(60)}\nshort`, 40, `${"x".repeat(14)}\n[… 46 characters clipped]`],
  ])("wholeLinesWithin: %s", (_, text, max, kept) => {
    expect(wholeLinesWithin(text, max)).toBe(kept)
  })

  const lines = Array.from({ length: 40 }, (_, index) => `line ${String(index).padStart(2, "0")} ${"x".repeat(41)}`)

  test.each([
    ["a report with no evidence gets an empty one", { id: "c1", name: "reportFinding", params: { path: "a.ts", line: 1 } }, { id: "c1", name: "reportFinding", params: { path: "a.ts", line: 1, evidence: "" } }],
    ["a report's own evidence stays", { id: "c2", name: "reportFinding", params: { line: 1, evidence: "x" } }, { id: "c2", name: "reportFinding", params: { line: 1, evidence: "x" } }],
    ["a report whose evidence is not text stays, for the tool to refuse", { id: "c3", name: "reportFinding", params: { evidence: 4 } }, { id: "c3", name: "reportFinding", params: { evidence: 4 } }],
    ["another tool's call stays", { id: "c4", name: "verdict", params: { outcome: "confirmed" } }, { id: "c4", name: "verdict", params: { outcome: "confirmed" } }],
    ["parameters that are no object stay", { id: "c5", name: "reportFinding", params: ["a.ts"] }, { id: "c5", name: "reportFinding", params: ["a.ts"] }],
  ])("withEvidence: %s", (_, call, given) => {
    expect(withEvidence(call)).toEqual(given)
  })

  test("keptReport: a claim past 1,500 characters cut with the marker, evidence past 1,000 its first whole lines, or its one long line cut; the rest as given", () => {
    const report = { path: "src/sum.ts", line: 4, kind: "bug", severity: "low", claim: "It multiplies by one.", evidence: "total += value * 1" }
    expect([
      keptReport(report),
      keptReport({ ...report, claim: "c".repeat(2_000), evidence: lines.join("\n") }),
      keptReport({ ...report, evidence: "e".repeat(1_200) }),
    ]).toEqual([
      report,
      { ...report, claim: `${"c".repeat(1_472)}\n[… 528 characters clipped]`, evidence: lines.slice(0, 20).join("\n") },
      { ...report, evidence: `${"e".repeat(972)}\n[… 228 characters clipped]` },
    ])
  })

  test("keptVerdict: a reason past 1,500 characters cut with the marker, a quote past 1,000 its first whole lines, or its one long line cut; the rest as given", () => {
    const verdict = { outcome: "confirmed", reason: "It multiplies by one.", quote: "total += value * 1" }
    expect([
      keptVerdict(verdict),
      keptVerdict({ ...verdict, reason: "r".repeat(2_000), quote: lines.join("\n") }),
      keptVerdict({ ...verdict, quote: "q".repeat(1_200) }),
    ]).toEqual([
      verdict,
      { ...verdict, reason: `${"r".repeat(1_472)}\n[… 528 characters clipped]`, quote: lines.slice(0, 20).join("\n") },
      { ...verdict, quote: `${"q".repeat(972)}\n[… 228 characters clipped]` },
    ])
  })
})

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
