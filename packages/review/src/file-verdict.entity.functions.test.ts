import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { attributesOf, fileVerdict } from "./file-verdict.entity.functions.js"
import type { FileStats } from "./file-verdict.entity.js"

const changed = { change: "modified" as const, additions: 3, deletions: 1, binary: false }

const ATTRIBUTES = attributesOf([
  "# generated code",
  "*.gen.ts linguist-generated",
  "api/*.txt linguist-generated=true",
  "/dist/** linguist-generated",
  "dist/keep.js -linguist-generated",
  "third_party/ours/** linguist-vendored=false",
  "lib/vendored-copy/** linguist-vendored",
  "[attr]binary -diff -merge -text",
  "*.png binary",
  "",
].join("\n"))

describe("attributesOf", () => {
  test("reads the linguist lines in order, set and unset, and passes over the rest", () => {
    expect(ATTRIBUTES.map((rule) => [rule.pattern, Option.getOrNull(rule.generated), Option.getOrNull(rule.vendored)])).toEqual([
      ["*.gen.ts", true, null],
      ["api/*.txt", true, null],
      ["/dist/**", true, null],
      ["dist/keep.js", false, null],
      ["third_party/ours/**", null, false],
      ["lib/vendored-copy/**", null, true],
    ])
  })
})

describe("fileVerdict", () => {
  const cases: ReadonlyArray<readonly [string, string, FileStats, string]> = [
    ["a lockfile at the root", "bun.lock", changed, "lockfile"],
    ["a lockfile in a package", "packages/app/yarn.lock", changed, "lockfile"],
    ["Cargo.lock", "crates/x/Cargo.lock", changed, "lockfile"],
    ["go.sum", "go.sum", changed, "lockfile"],
    ["poetry.lock", "py/poetry.lock", changed, "lockfile"],
    ["a name pattern matches at any depth", "src/deep/api.gen.ts", changed, "generated"],
    ["a pattern with a slash is anchored at the root", "api/list.txt", changed, "generated"],
    ["an anchored pattern does not match deeper", "docs/api/list.txt", changed, "Kept"],
    ["a folder pattern with **", "dist/app/index.js", changed, "generated"],
    ["a later line unsets an earlier one", "dist/keep.js", changed, "Kept"],
    ["a folder named vendor is kept: the pull request chooses its folders", "vendor/lib/a.go", changed, "Kept"],
    ["so is third_party", "pkg/third_party/z.c", changed, "Kept"],
    ["a file the base's .gitattributes marks vendored", "lib/vendored-copy/a.js", changed, "vendored"],
    ["a binary file", "logo.png", { change: "modified", additions: 0, deletions: 0, binary: true }, "binary"],
    ["a deleted file", "src/old.ts", { change: "deleted", additions: 0, deletions: 12, binary: false }, "deleted"],
    ["a file that stays and only loses lines (a removed check) is kept", "src/auth.ts", { change: "modified", additions: 0, deletions: 3, binary: false }, "Kept"],
    ["a pure rename, no lines", "src/moved.ts", { change: "renamed", additions: 0, deletions: 0, binary: false }, "Kept"],
    ["a file that changes lines", "src/app.ts", changed, "Kept"],
  ]
  test.each(cases)("%s", (_, path, stats, expected) => {
    const verdict = fileVerdict(path, stats, ATTRIBUTES)
    expect(verdict._tag === "Kept" ? "Kept" : verdict.reason).toBe(expected)
    expect(verdict.path).toBe(path)
  })
})
