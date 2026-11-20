import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import type { FileDiff } from "./diff.entity.js"
import { PassNumber } from "./finding.entity.js"
import type { Finding } from "./finding.entity.js"
import { changedLinesOf, checkRounds, evidenceMatches, mergeFindings, normalizedLine, quoteWithin } from "./vote.entity.functions.js"

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
  /** Each bucket as `line-endLine kind [pass.number…] votes why`. */
  const shown = (buckets: ReturnType<typeof mergeFindings>) =>
    buckets.map((bucket) => `${bucket.line}-${bucket.endLine} ${bucket.kind} [${bucket.members.map((member) => `${member.pass}.${member.number}`).join(" ")}] ${bucket.votes} ${bucket.why}`)

  test("a bucket is anchored at its first finding: those of other passes starting within three lines of it join, each pass once, whatever kind each says", () => {
    expect(shown(mergeFindings([
      finding(1, 1, 5), finding(2, 1, 8), finding(2, 2, 6), finding(3, 1, 10, { kind: "security" }), finding(3, 2, 15),
    ], [FILE], { vote: false }))).toEqual([
      "5-6 bug [1.1 2.2] 2 kept",
      "8-10 bug [2.1 3.1] 2 kept",
      "15-15 bug [3.2] 1 kept",
    ])
  })

  test("two findings of one pass never share a bucket, however near", () => {
    expect(shown(mergeFindings([finding(1, 1, 5), finding(1, 2, 5), finding(1, 3, 6)], [FILE], { vote: false }))).toEqual(["5-5 bug [1.1] 1 kept", "5-5 bug [1.2] 1 kept", "6-6 bug [1.3] 1 kept"])
  })

  test("no chaining: a finding near the last one joined, but not near the anchor, starts a bucket of its own", () => {
    expect(shown(mergeFindings([finding(1, 1, 5), finding(2, 1, 8), finding(3, 1, 10)], [FILE], { vote: false }))).toEqual(["5-8 bug [1.1 2.1] 2 kept", "10-10 bug [3.1] 1 kept"])
  })

  test("a finding's span counts at most forty lines: a 400-line one neither swallows the findings after it nor counts as on a changed line far down", () => {
    const wide = { ...FILE, hunks: FILE.hunks.map((hunk) => ({ ...hunk, newCount: 500, lines: [...hunk.lines, { _tag: "Added" as const, line: 380, text: "late()" }] })) }
    expect(shown(mergeFindings([finding(1, 1, 5, { endLine: 405 }), finding(2, 1, 60), finding(3, 1, 100, { endLine: 400 })], [wide], { vote: false }))).toEqual([
      "5-44 bug [1.1] 1 kept", "60-60 bug [2.1] 1 off-changed-lines", "100-139 bug [3.1] 1 off-changed-lines",
    ])
  })

  test("with the vote on: two passes, or one of them saying security; the rest recorded as left out by the vote", () => {
    expect(shown(mergeFindings([finding(1, 1, 5), finding(2, 1, 6, { kind: "security" }), finding(1, 2, 15), finding(3, 1, 10, { kind: "security" })], [FILE], { vote: true }))).toEqual([
      "5-6 bug [1.1 2.1] 2 kept", "10-10 security [3.1] 1 kept", "15-15 bug [1.2] 1 one-vote",
    ])
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

  test("the best-worded finding is the most severe first: a medium one with short evidence stands for a bucket over a low one with longer evidence the diff holds", () => {
    const [bucket] = mergeFindings([
      finding(2, 3, 5, { severity: "low", evidence: "  6 + added(5)\n  7   kept(7)" }),
      finding(4, 1, 6, { severity: "medium", evidence: "added(5)" }),
      finding(5, 1, 5, { severity: "medium", evidence: "not in the file" }),
    ], [FILE], { vote: false })
    // The medium ones first; among them the one whose evidence the diff holds; the low one's longer evidence loses.
    expect<ReadonlyArray<number | string | undefined>>([bucket?.best.pass, bucket?.best.severity, bucket?.votes]).toEqual([4, "medium", 3])
  })
})

describe("checkRounds", () => {
  /** Each round as `bucket:pass.number` per check. */
  const shown = (rounds: ReturnType<typeof checkRounds>) => rounds.map((round) => round.map((target) => `${target.bucket.number}:${target.finding.pass}.${target.finding.number}`))

  test("each kept bucket's best first, every bucket's first claim before any second, at most perBucket a bucket, none of a bucket not kept", () => {
    const findings = [
      finding(1, 1, 5, { severity: "low" }), finding(2, 1, 5, { severity: "high" }), finding(3, 1, 6), finding(4, 1, 5, { severity: "low" }),
      finding(1, 2, 10), finding(1, 3, 1),
    ]
    const buckets = mergeFindings(findings, [FILE], { vote: false })
    // Bucket 1 (line 1) is off the changed lines; bucket 2 holds four passes (best: the high one), bucket 3 one.
    expect([shown(checkRounds(buckets, findings, 3)), shown(checkRounds(buckets, findings, 1))]).toEqual([
      [["2:2.1", "3:1.2"], ["2:3.1"], ["2:1.1"]],
      [["2:2.1", "3:1.2"]],
    ])
  })

  test("no kept bucket, no round", () => {
    expect(checkRounds(mergeFindings([finding(1, 1, 1)], [FILE], { vote: false }), [finding(1, 1, 1)], 3)).toEqual([])
  })
})

describe("the quotes", () => {
  test("normalizedLine: a tool's number and marker off, white space made one space", () => {
    expect(["  42| const a  =  1", "  42 + const a = 1", "  42   const a = 1", "\tconst\ta = 1 "].map(normalizedLine)).toEqual(Array(4).fill("const a = 1"))
  })

  test("evidenceMatches: every quoted line is in a line of the diff's new side", () => {
    expect([evidenceMatches("added(5)\nkept(7)", FILE), evidenceMatches("added(5)\ngone()", FILE), evidenceMatches("", FILE), evidenceMatches("x", undefined)]).toEqual([true, false, false, false])
  })

  test("quoteWithin: a whole line of the cited lines (one either side) in a quote the cited lines and three around them hold; elsewhere, or empty, it is not", () => {
    const text = Array.from({ length: 30 }, (_, index) => `const value${index + 1} = compute(${index + 1});`).join("\n")
    expect([
      quoteWithin(text, "const value10 = compute(10);\n  const value11 = compute(11);", 10, 10),
      quoteWithin(text, "const value9 = compute(9);", 10, 10),
      quoteWithin(text, "  11| const value11 = compute(11);", 10, 10),
      quoteWithin(text, "const value7 = compute(7);\nconst value8 = compute(8);\nconst value9 = compute(9);", 10, 10),
      quoteWithin(text, "const value12 = compute(12);\nconst value13 = compute(13);", 10, 10),
      quoteWithin(text, "const value13 = compute(13);", 10, 10),
      quoteWithin(text, "const value7 = compute(7);", 10, 10),
      quoteWithin(text, "const value14 = compute(14);", 10, 10),
      quoteWithin(text, "", 10, 10),
    ]).toEqual([true, true, true, true, false, false, false, false, false])
  })

  test("quoteWithin: a generic line elsewhere in the window proves nothing; the cited line does", () => {
    const text = ["export const total = (items: Items) => {", "  const result = sum(items)", "  if (result > limit) {", "    log(result)", "  }", "  return result", "}"].join("\n")
    expect([
      quoteWithin(text, "  return result", 3, 3),
      quoteWithin(text, "  }\n  return result", 3, 3),
      quoteWithin(text, "  if (result > limit) {", 3, 3),
      quoteWithin(text, "  const result = sum(items)", 3, 3),
    ]).toEqual([false, false, true, true])
  })

  test("quoteWithin: a quote must hold a whole line that stands for code; a brace, a keyword or part of a line is not enough", () => {
    const text = ["export const run = (input: Input) => {", "  if (input.ready) {", "    return start(input.name)", "  }", "  return", "}"].join("\n")
    expect([
      quoteWithin(text, "}", 1, 6),
      quoteWithin(text, "return", 1, 6),
      quoteWithin(text, "  }\n  return", 1, 6),
      quoteWithin(text, "start(input", 1, 6),
      quoteWithin(text, "return start(input.name)", 1, 6),
      quoteWithin(text, "  if (input.ready) {\n    return start(", 1, 6),
    ]).toEqual([false, false, false, false, true, true])
  })

  test("quoteWithin: the cited lines never run past forty from the first, whatever endLine says", () => {
    const text = Array.from({ length: 1_000 }, (_, index) => `const value${index + 1} = compute(${index + 1});`).join("\n")
    expect([
      quoteWithin(text, "const value41 = compute(41);", 1, 1_000),
      quoteWithin(text, "const value42 = compute(42);", 1, 1_000),
      quoteWithin(text, "const value43 = compute(43);", 1, 1_000),
      quoteWithin(text, "const value900 = compute(900);", 1, 1_000),
    ]).toEqual([true, false, false, false])
  })
})
