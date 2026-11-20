import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import type { PullTimeline } from "./forge.entity.js"
import { descriptionAsOf, firstHeadOf } from "./forge.entity.functions.js"
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

describe("descriptionAsOf", () => {
  const saved = (editedAt: string, text: string | null) => ({ editedAt, text: Option.fromNullishOr(text) })
  const OPENED = saved("2026-11-01T09:00:00Z", "as opened")
  const BEFORE = saved("2026-11-01T09:30:00+00:00", "edited before the commit")
  const AFTER = saved("2026-11-02T08:00:00Z", "edited after: lists the fixes")
  const AT = "2026-11-01T10:00:00Z"
  test.each([
    ["never edited: none, the current text stands", AT, [], 0, Option.none()],
    ["the last version saved at or before the commit, whatever the order listed", AT, [AFTER, BEFORE, OPENED], 3, Option.some("edited before the commit")],
    ["a version saved at the commit's very time counts", "2026-11-01T09:30:00Z", [AFTER, BEFORE, OPENED], 3, Option.some("edited before the commit")],
    ["every version later (opened after the commit): the one it was opened with", "2026-10-31T00:00:00Z", [AFTER, OPENED], 2, Option.some("as opened")],
    ["every version read later, but more in the history than read: none", "2026-10-31T00:00:00Z", [AFTER, OPENED], 120, Option.none()],
    ["a version whose text was deleted from the history is passed over", AT, [AFTER, saved("2026-11-01T09:30:00Z", null), OPENED], 3, Option.some("as opened")],
    ["no version's text kept: none", AT, [saved("2026-11-01T09:00:00Z", null)], 1, Option.none()],
    ["a commit time that does not read: none", "", [AFTER, OPENED], 2, Option.none()],
    ["a version whose time does not read is passed over", AT, [saved("yesterday", "unread time"), OPENED], 2, Option.some("as opened")],
  ] as const)("%s", (_, committedAt, edits, total, text) => {
    expect<unknown>(descriptionAsOf({ committedAt, edits, total })).toEqual(text)
  })
})
