import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { estimateTokens } from "@xandreed/sdk"
import type { FileDiff } from "./diff.entity.js"
import { renderDiff } from "./diff.entity.functions.js"
import { REQUEST_SLACK_BYTES } from "./file-group.entity.js"
import { firstCallBytes, firstCallHold, groupFiles, isGrouped, orderGroups, packageFoldersToLook, packageOf, riskOf, stemOf, ungroupedOf } from "./file-group.entity.functions.js"

/** A modified file whose one hunk adds `added` lines. */
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

const tokens = (files: ReadonlyArray<FileDiff>) => files.reduce((sum, one) => sum + Number(estimateTokens(renderDiff([one]))), 0)
const paths = (groups: ReturnType<typeof groupFiles>): ReadonlyArray<readonly [number, string, ReadonlyArray<string>]> => groups.map((group) => [Number(group.number), group.package, group.paths])

describe("the groups of a focused review", () => {
  test("packageOf: the deepest folder holding a package.json, . for the root or none; the folders to look in", () => {
    const roots = new Set(["", "packages/sdk", "packages/sdk/src/kernel/node"])
    expect([packageOf("packages/sdk/src/a.ts", roots), packageOf("packages/sdk/src/kernel/node/b.ts", roots), packageOf("scripts/c.ts", roots), packageOf("x.ts", new Set())]).toEqual(["packages/sdk", "packages/sdk/src/kernel/node", ".", "."])
    expect(packageFoldersToLook(["packages/a/src/x.ts", "packages/a/y.ts", "z.ts"])).toEqual(["", "packages", "packages/a", "packages/a/src"])
  })

  test("stemOf and isGrouped: a name to its first dot; code is grouped (tests, pages, a docs folder's code and .astro files too), config, manifests and docs are not", () => {
    expect(["src/charge.adapter.test.ts", "a/b/render-feed.adapter.ts", "Makefile"].map(stemOf)).toEqual(["charge", "render-feed", "Makefile"])
    expect(["src/a.ts", "src/a.test.ts", "site/pages/x.astro", "docs/x.ts", "site/pages/api.ts", "package.json", "biome.json", "README.md", "docs/guide.mdx"].map(isGrouped)).toEqual([true, true, true, true, true, false, false, false, false])
  })

  test("ungroupedOf: each file a review reads that no group holds, with why", () => {
    const files = [file("src/a.ts", 1), file("package.json", 1), file("biome.json", 1), file("README.md", 1), file("src/b.ts", 1)]
    const groups = groupFiles(files.slice(0, 1), new Set(), { tokens: 6_000, files: 8 })
    expect(ungroupedOf(files, groups)).toEqual([
      { path: "package.json", why: "a manifest or CI file" }, { path: "biome.json", why: "config" }, { path: "README.md", why: "docs" }, { path: "src/b.ts", why: "code no group holds" },
    ])
  })

  test("firstCallBytes and firstCallHold: the messages as JSON, escapes counted, and REQUEST_SLACK_BYTES; at the input price, a full answer at the output price", () => {
    // A newline-heavy prompt: each line break is two bytes in JSON, each quote two.
    const prompt = { prefix: [{ role: "system" as const, content: "\n".repeat(1_000) }, { role: "user" as const, content: "\"".repeat(500) }], tail: "é".repeat(500) }
    const json = new TextEncoder().encode(JSON.stringify({ messages: [...prompt.prefix, { role: "user", content: prompt.tail }] })).length
    expect([json > 4_000, firstCallBytes(prompt)]).toEqual([true, json + REQUEST_SLACK_BYTES])
    const price = { input: 0.3, output: 1.2, maxOutputTokens: 4_096, bytesPerToken: 1 }
    expect(Math.round(firstCallHold(prompt, price) * 1e9)).toBe(Math.round((((json + 8_000) * 0.3) / 1e6 + (4_096 * 1.2) / 1e6) * 1e9))
    expect(Math.round(firstCallHold(prompt, { ...price, bytesPerToken: 4 }) * 1e9)).toBe(Math.round((((json + 8_000) / 4) * 0.3 / 1e6 + (4_096 * 1.2) / 1e6) * 1e9))
  })

  test("riskOf: risky added lines of source count four, of a test one, and each source line a hundredth", () => {
    const lines = (path: string, texts: ReadonlyArray<string>): FileDiff => ({ ...file(path, 0), additions: texts.length, hunks: [{ oldStart: 1, oldCount: 0, newStart: 1, newCount: texts.length, section: "", lines: texts.map((text, at) => ({ _tag: "Added" as const, line: at + 1, text })) }] })
    expect([
      riskOf([lines("src/a.ts", ["const ref = yield* Ref.make(0)", "const total = 1", "yield* Effect.forkScoped(run)", "fs.open(path)"])]),
      riskOf([lines("src/a.test.ts", ["const lock = yield* Semaphore.make(1)", "plain"])]),
      riskOf([lines("src/b.ts", ["const references = 1", "const umask = 0o22", "TOKEN_LIMIT"])]),
    ]).toEqual([3 * 4 + 0.04, 1, 4 + 4 + 0.03])
  })

  test("orderGroups: riskiest first, ties in git's order, renumbered from 1; git keeps the order given", () => {
    const calm = file("src/calm.ts", 3)
    const risky = { ...file("src/risky.ts", 1), hunks: [{ oldStart: 1, oldCount: 0, newStart: 1, newCount: 1, section: "", lines: [{ _tag: "Added" as const, line: 1, text: "spawn(process)" }] }] }
    const tie = file("src/tie.ts", 3)
    const groups = groupFiles([calm, risky, tie], new Set(), { tokens: 6_000, files: 1 })
    expect(paths(orderGroups(groups, [calm, risky, tie], "risk"))).toEqual([[1, ".", ["src/risky.ts"]], [2, ".", ["src/calm.ts"]], [3, ".", ["src/tie.ts"]]])
    expect(paths(orderGroups(groups, [calm, risky, tie], "git"))).toEqual(paths(groups))
  })

  test("orderGroups: a risky tests-only group runs after every source group, and the config group last", () => {
    const riskyTest = { ...file("src/z.test.ts", 1), hunks: [{ oldStart: 1, oldCount: 0, newStart: 1, newCount: 1, section: "", lines: [{ _tag: "Added" as const, line: 1, text: "spawn(fork(lock))" }] }] }
    const calm = file("src/calm.ts", 3)
    const config = { ...file("ci.yml", 1), hunks: [{ oldStart: 1, oldCount: 0, newStart: 1, newCount: 1, section: "", lines: [{ _tag: "Added" as const, line: 1, text: "secret: token" }] }] }
    const all = [riskyTest, calm, config]
    const groups = groupFiles(all, new Set(), { tokens: 6_000, files: 1 }, true)
    expect(paths(orderGroups(groups, all, "risk"))).toEqual([[1, ".", ["src/calm.ts"]], [2, ".", ["src/z.test.ts"]], [3, ".", ["ci.yml"]]])
  })

  test("a package within the bounds is one group, its port and adapter in different folders together; packages in git's order, tests-only groups last", () => {
    const roots = new Set(["packages/render", "packages/app"])
    const files = [
      file("packages/app/src/only.test.ts", 3),
      file("packages/render/src/ports/render.port.ts", 5),
      file("packages/render/src/render-feed.adapter.ts", 10),
      file("packages/render/package.json", 2),
      file("packages/render/README.md", 8),
    ]
    expect(paths(groupFiles(files, roots, { tokens: 6_000, files: 8 }))).toEqual([
      [1, "packages/render", ["packages/render/src/ports/render.port.ts", "packages/render/src/render-feed.adapter.ts"]],
      [2, "packages/app", ["packages/app/src/only.test.ts"]],
    ])
  })

  test("a package over the bounds is cut by stem: a stem's files stay together, a test in a test folder joins its source, units filled in order up to the bounds", () => {
    const roots = new Set(["pkg"])
    const files = [
      file("pkg/src/a.adapter.ts", 10), file("pkg/src/a.port.ts", 10), file("pkg/src/b.ts", 10), file("pkg/src/c.ts", 10),
      file("pkg/test/a.test.ts", 10), file("pkg/src/c.test.ts", 10),
    ]
    expect(paths(groupFiles(files, roots, { tokens: 6_000, files: 3 }))).toEqual([
      [1, "pkg", ["pkg/src/a.adapter.ts", "pkg/src/a.port.ts", "pkg/test/a.test.ts"]],
      [2, "pkg", ["pkg/src/b.ts", "pkg/src/c.ts", "pkg/src/c.test.ts"]],
    ])
    // One file fewer allowed: b alone, since c's unit would make four.
    expect(paths(groupFiles([...files, file("pkg/src/b.test.ts", 10)], roots, { tokens: 6_000, files: 3 })).slice(1)).toEqual([
      [2, "pkg", ["pkg/src/b.ts", "pkg/src/b.test.ts"]],
      [3, "pkg", ["pkg/src/c.ts", "pkg/src/c.test.ts"]],
    ])
  })

  test("by tokens: a file over the bound is a group alone, a unit over it cut into its files; each group's tokens its diffs'", () => {
    const big = file("src/big.ts", 300)
    const small = [file("src/x.ts", 5), file("src/x.test.ts", 5)]
    const bound = tokens(small) + 1
    const groups = groupFiles([small[0]!, big, small[1]!], new Set(), { tokens: bound, files: 8 })
    expect(paths(groups)).toEqual([[1, ".", ["src/x.ts", "src/x.test.ts"]], [2, ".", ["src/big.ts"]]])
    expect(groups.map((group) => group.tokens)).toEqual([tokens(small), tokens([big])])
    const unit = [file("src/y.ts", 300), file("src/y.test.ts", 300)]
    expect(paths(groupFiles(unit, new Set(), { tokens: tokens(unit) - 1, files: 8 }))).toEqual([[1, ".", ["src/y.ts"]], [2, ".", ["src/y.test.ts"]]])
  })

  test("with config, the files outside every group but pages and docs are one group more, last", () => {
    const files = [file("src/a.ts", 3), file("biome.json", 2), file("package.json", 1), file("README.md", 4)]
    expect(paths(groupFiles(files, new Set([""]), { tokens: 6_000, files: 8 }, true))).toEqual([[1, ".", ["src/a.ts"]], [2, ".", ["biome.json", "package.json"]]])
    expect(paths(groupFiles(files, new Set([""]), { tokens: 6_000, files: 8 }))).toEqual([[1, ".", ["src/a.ts"]]])
  })
})
