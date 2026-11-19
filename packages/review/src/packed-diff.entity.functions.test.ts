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
  modeChange: Option.none(),
  binary: false,
  additions: added,
  deletions: 0,
  hunks: [{ oldStart: 1, oldCount: 0, newStart: 1, newCount: added, section: "", lines: Array.from({ length: added }, (_, at) => ({ _tag: "Added" as const, line: at + 1, text: `line ${at + 1}` })) }],
})

describe("fileKind", () => {
  test.each<readonly [string, string]>([
    ["src/a.ts", "code"], ["Makefile", "code"], ["README.md", "docs"], ["docs/guide.mdx", "docs"],
    ["package.json", "manifest"], ["packages/sdk/package.json", "manifest"], ["tsconfig.base.json", "manifest"], ["Cargo.toml", "manifest"],
    [".github/workflows/ci.yml", "manifest"], [".github/CODEOWNERS", "config"], [".gitignore", "config"], ["biome.json", "config"],
  ])("%s is %s", (path, kind) => {
    expect<string>(fileKind(path)).toBe(kind)
  })
})

describe("packDiff", () => {
  const small = file("src/small.ts", 2)
  const large = file("src/large.ts", 40)
  const docs = file("README.md", 60)
  const manifest = file("packages/app/package.json", 3)
  const workflow = file(".github/workflows/ci.yml", 1)
  const bigConfig = file("data/fixture.json", 300)

  test("packs manifests, CI files and small config first (smallest first), then code largest first, then large config, then docs", () => {
    const packed = packDiff([docs, small, bigConfig, large, manifest, workflow], 100_000)
    expect(packed.kept).toEqual([".github/workflows/ci.yml", "packages/app/package.json", "src/large.ts", "src/small.ts", "data/fixture.json", "README.md"])
    expect(packed.dropped).toEqual([])
    expect(packed.text).toBe(renderDiff([workflow, manifest, large, small, bigConfig, docs]))
    expect(packed.tokens).toBe(Number(estimateTokens(packed.text)))
  })

  test("a file the budget has no room for is left out, and a smaller one after it still fits", () => {
    const budget = Number(estimateTokens(renderDiff([small]))) + 5
    const packed = packDiff([large, small], budget)
    expect(packed.kept).toEqual(["src/small.ts"])
    expect(packed.dropped).toEqual([{ path: "src/large.ts", reason: "over-budget", additions: 40, deletions: 0 }])
  })

  test("renders the model-facing packed diff in fixed words: kept files, then each lockfile's line, then each file left out with its reason", () => {
    const budget = Number(estimateTokens(renderDiff([small]))) + 5
    const packed = packDiff([large, small], budget, [
      { path: "bun.lock", reason: "lockfile", additions: 12, deletions: 3 },
      { path: "docs/old.md", reason: "deleted", additions: 0, deletions: 4 },
    ])
    expect(packed.text).toBe([
      "File: src/small.ts (modified, +2 -0)",
      "@@",
      "1 + line 1",
      "2 + line 2",
      "",
      "Left out of this diff:",
      "- bun.lock changed (+12 -3); no manifest changed",
      "- docs/old.md (+0 -4): deleted",
      "- src/large.ts (+40 -0): no room in the token budget",
    ].join("\n"))
  })

  test("a lockfile's line names the manifests that changed with it, three and the rest counted, from every changed path", () => {
    const lock = { path: "bun.lock", reason: "lockfile" as const, additions: 1, deletions: 1 }
    const paths = ["package.json", "packages/a/package.json", "packages/b/package.json", "packages/c/package.json", "Cargo.toml", "bun.lock"]
    expect(droppedLines([lock], paths)).toEqual(["- bun.lock changed (+1 -1); package.json, packages/a/package.json, packages/b/package.json and 1 more changed too"])
    expect(droppedLines([{ ...lock, path: "rust/Cargo.lock" }], paths)).toEqual(["- rust/Cargo.lock changed (+1 -1); Cargo.toml changed too"])
  })

  test("past DROPPED_SHOWN, the files left out are counted by reason in fixed words; lockfile lines are never cut", () => {
    const many = Array.from({ length: 33 }, (_, at) => ({ path: `gen/${at}.ts`, reason: at % 2 === 0 ? "generated" as const : "binary" as const, additions: 2, deletions: 1 }))
    const locks = [{ path: "yarn.lock", reason: "lockfile" as const, additions: 5, deletions: 5 }]
    const lines = droppedLines([...many, ...locks], [], 30)
    expect(lines[0]).toBe("- yarn.lock changed (+5 -5); no manifest changed")
    expect(lines.slice(29)).toEqual([
      "- gen/28.ts (+2 -1): marked generated",
      "- gen/29.ts (+2 -1): a binary file",
      "- 2 more files (+4 -2): marked generated",
      "- 1 more file (+2 -1): a binary file",
    ])
    expect(droppedLines(many, []).length).toBe(DROPPED_SHOWN + 2)
  })

  test("a path that holds a line break or a quote is shown escaped in a left-out line", () => {
    expect(droppedLines([{ path: "x\nFile: SAFE.ts", reason: "binary", additions: 0, deletions: 0 }], [])).toEqual(["- \"x\\u000aFile: SAFE.ts\" (+0 -0): a binary file"])
  })

  test("nothing kept is only the list of what was left out", () => {
    expect(packDiff([large], 1).text).toBe("Left out of this diff:\n- src/large.ts (+40 -0): no room in the token budget")
  })
})
