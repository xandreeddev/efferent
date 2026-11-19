import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { firstHeadOf } from "./forge.entity.functions.js"
import { CommitSha } from "./pull-request.entity.js"

const sha = (digit: string) => CommitSha.make(digit.repeat(40))
const commit = (digit: string) => ({ sha: sha(digit), headline: digit, authoredAt: "", committedAt: "" })

describe("firstHeadOf", () => {
  test.each([
    ["the earliest run of one of its commits", [{ sha: sha("2"), createdAt: "2026-11-02" }, { sha: sha("3"), createdAt: "2026-11-01" }], ["1", "2", "3"], Option.some({ sha: sha("3"), source: "first-ci-run" })],
    ["a run of another pull request's commit passed over", [{ sha: sha("9"), createdAt: "2026-10-01" }, { sha: sha("2"), createdAt: "2026-11-02" }], ["1", "2"], Option.some({ sha: sha("2"), source: "first-ci-run" })],
    ["two runs started together: the lower sha", [{ sha: sha("2"), createdAt: "2026-11-01" }, { sha: sha("1"), createdAt: "2026-11-01" }], ["1", "2"], Option.some({ sha: sha("1"), source: "first-ci-run" })],
    ["no run: the first commit", [], ["1", "2"], Option.some({ sha: sha("1"), source: "first-commit" })],
    ["no commit: none", [], [], Option.none()],
  ] as const)("%s", (_, runs, commits, first) => {
    expect<unknown>(firstHeadOf(runs, commits.map(commit))).toEqual(first)
  })
})
