import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import type { FileDiff } from "./diff.entity.js"
import { PassNumber } from "./finding.entity.js"
import type { Finding } from "./finding.entity.js"
import { changedLinesOf, evidenceMatches, mergeFindings, normalizedLine, quoteWithin } from "./vote.entity.functions.js"

/** A file whose new side is lines 1 to 20, `added` the lines the change adds, one line removed before line 15. */
const FILE: FileDiff = {
  path: "src/a.ts",
  oldPath: Option.none(),
  change: "modified",
  modeChange: Option.none(),
  binary: false,
  additions: 3,
  deletions: 1,
  hunks: [{
    oldStart: 1,
    oldCount: 18,
    newStart: 1,
    newCount: 20,
    section: "",
    lines: Array.from({ length: 20 }, (_, index) => index + 1).flatMap((line) => [
      ...(line === 15 ? [{ _tag: "Removed" as const, text: "gone()" }] : []),
      [5, 6, 10].includes(line) ? { _tag: "Added" as const, line, text: `  added(${line})  ` } : { _tag: "Context" as const, line, text: `kept(${line})` },
    ]),
  }],
}

const finding = (pass: number, number: number, line: number, extra: Partial<Finding> = {}): Finding => ({
  path: "src/a.ts", line, kind: "bug", severity: "medium", claim: `claim ${pass}.${number}`, evidence: "", pass: PassNumber.make(pass), number, ...extra,
})

describe("changedLinesOf", () => {
  test("the added lines, and where removed lines stood", () => {
    expect([...changedLinesOf(FILE)].sort((a, b) => a - b)).toEqual([5, 6, 10, 15])
  })
})

describe("mergeFindings", () => {
  test("near findings of one kind share a bucket, its votes its distinct passes; another kind or a far line is another bucket", () => {
    const buckets = mergeFindings([
      finding(1, 1, 5), finding(2, 1, 8), finding(2, 2, 6), finding(3, 1, 10, { kind: "security" }), finding(3, 2, 15),
    ], [FILE], { vote: false })
    expect(buckets.map((bucket) => [bucket.number, bucket.kind, bucket.line, bucket.endLine, bucket.members.map((member) => `${member.pass}.${member.number}`), bucket.votes, bucket.why])).toEqual([
      [1, "bug", 5, 8, ["1.1", "2.2", "2.1"], 2, "kept"],
      [2, "bug", 15, 15, ["3.2"], 1, "kept"],
      [3, "security", 10, 10, ["3.1"], 1, "kept"],
    ])
  })

  test("with the vote on: two passes, or one for a security problem; the rest recorded as left out by the vote", () => {
    const buckets = mergeFindings([finding(1, 1, 5), finding(2, 1, 6), finding(1, 2, 15), finding(3, 1, 10, { kind: "security" })], [FILE], { vote: true })
    expect(buckets.map((bucket) => [bucket.line, bucket.kind, bucket.why, bucket.kept])).toEqual([[5, "bug", "kept", true], [15, "bug", "one-vote", false], [10, "security", "kept", true]])
  })

  test("a finding off the changed lines (more than two from one) is bucketed apart and never kept", () => {
    const buckets = mergeFindings([finding(1, 1, 1), finding(2, 1, 1), finding(1, 2, 12), finding(1, 3, 20, { path: "src/other.ts" })], [FILE], { vote: false })
    expect(buckets.map((bucket) => [bucket.path, bucket.line, bucket.votes, bucket.why])).toEqual([["src/a.ts", 1, 2, "off-changed-lines"], ["src/a.ts", 12, 1, "kept"], ["src/other.ts", 20, 1, "off-changed-lines"]])
  })

  test("the best-worded finding: the longest evidence the diff holds, else the first found", () => {
    const [matched] = mergeFindings([
      finding(1, 1, 5, { evidence: "this is not in the file at all, and is long" }),
      finding(2, 1, 5, { evidence: "added(5)" }),
      finding(3, 1, 6, { evidence: "  6 + added(5)\n  7   kept(7)" }),
    ], [FILE], { vote: false })
    const [first] = mergeFindings([finding(2, 1, 5, { evidence: "nowhere" }), finding(1, 4, 5, { evidence: "elsewhere" })], [FILE], { vote: false })
    expect<ReadonlyArray<number | undefined>>([matched?.best.pass, first?.best.pass]).toEqual([3, 1])
  })
})

describe("the quotes", () => {
  test("normalizedLine: a tool's number and marker off, white space made one space", () => {
    expect(["  42| const a  =  1", "  42 + const a = 1", "  42   const a = 1", "\tconst\ta = 1 "].map(normalizedLine)).toEqual(Array(4).fill("const a = 1"))
  })

  test("evidenceMatches: every quoted line is in a line of the diff's new side", () => {
    expect([evidenceMatches("added(5)\nkept(7)", FILE), evidenceMatches("added(5)\ngone()", FILE), evidenceMatches("", FILE), evidenceMatches("x", undefined)]).toEqual([true, false, false, false])
  })

  test("quoteWithin: the quote is in the file within the cited lines and three around them; elsewhere, or empty, it is not", () => {
    const text = Array.from({ length: 30 }, (_, index) => `line ${index + 1};`).join("\n")
    expect([
      quoteWithin(text, "line 10;\n  line 11;", 10, 10),
      quoteWithin(text, "line 13;", 10, 10),
      quoteWithin(text, "line 14;", 10, 10),
      quoteWithin(text, "line 7;", 10, 10),
      quoteWithin(text, "line 6;", 10, 10),
      quoteWithin(text, "  12| line 12;", 10, 10),
      quoteWithin(text, "", 10, 10),
    ]).toEqual([true, true, false, true, false, true, false])
  })
})
