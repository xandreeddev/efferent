import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { estimateTokens } from "@xandreed/sdk"
import type { FileDiff } from "./diff.entity.js"
import { renderDiff } from "./diff.entity.functions.js"
import { droppedLines, fileKind, packDiff } from "./packed-diff.entity.functions.js"
import { DROPPED_SHOWN } from "./packed-diff.entity.js"

/** A modified file whose one hunk adds `added` lines, each `line <n>`. */
const file = (path: string, added: number): FileDiff => ({
  path,
  oldPath: Option.none(),
  change: "modified",
  binary: false,
  additions: added,
  deletions: 0,
  hunks: [{ oldStart: 1, oldCount: 0, newStart: 1, newCount: added, section: "", lines: Array.from({ length: added }, (_, at) => ({ _tag: "Added" as const, line: at + 1, text: `line ${at + 1}` })) }],
})

describe("fileKind", () => {
  test.each<readonly [string, string]>([
    ["src/a.ts", "code"], ["Makefile", "code"], ["README.md", "docs"], ["docs/guide.mdx", "docs"], ["package.json", "config"],
    [".github/workflows/ci.yml", "config"], [".gitignore", "config"], ["Cargo.toml", "config"],
  ])("%s is %s", (path, kind) => {
    expect<string>(fileKind(path)).toBe(kind)
  })
})

describe("packDiff", () => {
  const small = file("src/small.ts", 2)
  const large = file("src/large.ts", 40)
  const docs = file("README.md", 60)
  const config = file("package.json", 1)

  test("packs code before docs before config, the largest first, under the budget", () => {
    const packed = packDiff([config, docs, small, large], 100_000)
    expect(packed.kept).toEqual(["src/large.ts", "src/small.ts", "README.md", "package.json"])
    expect(packed.dropped).toEqual([])
    expect(packed.text).toBe(renderDiff([large, small, docs, config]))
    expect(packed.tokens).toBe(Number(estimateTokens(packed.text)))
  })

  test("a file the budget has no room for is left out, and a smaller one after it still fits", () => {
    const budget = Number(estimateTokens(renderDiff([small]))) + 5
    const packed = packDiff([large, small], budget)
    expect(packed.kept).toEqual(["src/small.ts"])
    expect(packed.dropped).toEqual([{ path: "src/large.ts", reason: "over-budget", additions: 40, deletions: 0 }])
  })

  test("renders the model-facing packed diff in fixed words: kept files, then each file left out with its reason", () => {
    const budget = Number(estimateTokens(renderDiff([small]))) + 5
    const packed = packDiff([large, small], budget, [{ path: "bun.lock", reason: "lockfile", additions: 12, deletions: 3 }])
    expect(packed.text).toBe([
      "File: src/small.ts (modified, +2 -0)",
      "@@",
      "1 + line 1",
      "2 + line 2",
      "",
      "Left out of this diff:",
      "- bun.lock (+12 -3): a lockfile",
      "- src/large.ts (+40 -0): no room in the token budget",
    ].join("\n"))
  })

  test("past DROPPED_SHOWN, the files left out are counted by reason in fixed words", () => {
    const many = Array.from({ length: 33 }, (_, at) => ({ path: `gen/${at}.ts`, reason: at % 2 === 0 ? "generated" as const : "lockfile" as const, additions: 2, deletions: 1 }))
    expect(droppedLines(many, 30).slice(28)).toEqual([
      "- gen/28.ts (+2 -1): marked generated",
      "- gen/29.ts (+2 -1): a lockfile",
      "- 2 more files (+4 -2): marked generated",
      "- 1 more file (+2 -1): a lockfile",
    ])
    expect(droppedLines(many).length).toBe(DROPPED_SHOWN + 2)
  })

  test("nothing kept is only the list of what was left out", () => {
    expect(packDiff([large], 1).text).toBe("Left out of this diff:\n- src/large.ts (+40 -0): no room in the token budget")
  })
})
