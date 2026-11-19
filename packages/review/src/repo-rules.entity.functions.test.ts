import { describe, expect, test } from "bun:test"
import { rulesAlong } from "./repo-rules.entity.functions.js"

const at = (folder: string) => ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "REVIEW.md"].map((name) => (folder === "" ? name : `${folder}/${name}`))

describe("rulesAlong", () => {
  test.each([
    ["no changed path: the root's alone", [], at("")],
    ["a file at the root", ["README.md"], at("")],
    ["a nested file: the root, then each folder down to it", ["packages/sdk/src/a.ts"], [...at(""), ...at("packages"), ...at("packages/sdk"), ...at("packages/sdk/src")]],
    ["two paths share their folders once, in the order met", ["packages/b/x.ts", "packages/a/y.ts", "packages/b/z.ts"], [...at(""), ...at("packages"), ...at("packages/b"), ...at("packages/a")]],
  ] as const)("%s", (_, paths, expected) => {
    expect(rulesAlong(paths)).toEqual(expected)
  })
})
