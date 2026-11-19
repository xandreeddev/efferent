import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import type { PullTimeline } from "./forge.entity.js"
import { firstHeadOf } from "./forge.entity.functions.js"
import { CommitSha } from "./pull-request.entity.js"

const sha = (digit: string) => CommitSha.make(digit.repeat(40))
const commit = (digit: string) => ({ sha: sha(digit), headline: digit, authoredAt: "", committedAt: "" })
const run = (digit: string, createdAt: string) => ({ sha: digit.repeat(40), createdAt })

const OPEN: PullTimeline = { opened: "2026-11-01T00:00:00Z", closed: Option.some("2026-11-05T00:00:00Z"), forcePushes: [] }
const PUSHED: PullTimeline = { ...OPEN, forcePushes: [{ at: "2026-11-03T00:00:00Z", before: Option.some("7".repeat(40)) }, { at: "2026-11-02T00:00:00Z", before: Option.some("8".repeat(40)) }] }

describe("firstHeadOf", () => {
  test.each([
    ["the earliest run while it was open", [run("2", "2026-11-02T00:00:00Z"), run("3", "2026-11-01T01:00:00Z")], OPEN, ["1", "2", "3"], Option.some({ sha: sha("3"), source: "first-ci-run" })],
    ["a run of a commit a force-push dropped from the list still counts", [run("9", "2026-11-01T01:00:00Z"), run("2", "2026-11-02T00:00:00Z")], PUSHED, ["1", "2"], Option.some({ sha: sha("9"), source: "first-ci-run" })],
    ["a run before it opened or after it closed (another pull request on the branch) is passed over", [run("9", "2026-10-01T00:00:00Z"), run("8", "2026-11-06T00:00:00Z"), run("2", "2026-11-02T00:00:00Z")], OPEN, ["1", "2"], Option.some({ sha: sha("2"), source: "first-ci-run" })],
    ["two runs started together: the lower sha", [run("2", "2026-11-02T00:00:00Z"), run("1", "2026-11-02T00:00:00Z")], OPEN, ["1", "2"], Option.some({ sha: sha("1"), source: "first-ci-run" })],
    ["a run's sha that is no commit's is passed over", [{ sha: "not-a-sha", createdAt: "2026-11-01T01:00:00Z" }], OPEN, ["1"], Option.some({ sha: sha("1"), source: "first-commit" })],
    ["no run but force-pushes: the head the first one replaced, said so", [], PUSHED, ["1", "2"], Option.some({ sha: sha("8"), source: "before-first-force-push" })],
    ["no run, no force-push: the first commit, said so", [], OPEN, ["1", "2"], Option.some({ sha: sha("1"), source: "first-commit" })],
    ["no commit: none", [], OPEN, [], Option.none()],
  ] as const)("%s", (_, runs, timeline, commits, first) => {
    expect<unknown>(firstHeadOf(runs, timeline, commits.map(commit))).toEqual(first)
  })

  test("a pull request still open takes every later run", () => {
    expect<unknown>(firstHeadOf([run("4", "2027-01-01T00:00:00Z")], { ...OPEN, closed: Option.none() }, [commit("1")])).toEqual(Option.some({ sha: sha("4"), source: "first-ci-run" }))
  })
})
