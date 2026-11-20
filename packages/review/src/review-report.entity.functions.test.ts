import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { SessionId } from "@xandreed/core"
import { GroupNumber, NOT_REVIEWED_BECAUSE } from "./file-group.entity.js"
import { lookupFailedNote, noCallWhy } from "./file-group.entity.functions.js"
import { CheckNumber, PassNumber } from "./finding.entity.js"
import type { Finding } from "./finding.entity.js"
import type { PassResult } from "./review-pass.entity.js"
import { PREPARED } from "./review-prompt.testing.js"
import type { BucketCheck } from "./review-report.entity.js"
import { reportText, restatesCi, reviewReport, runNameOf } from "./review-report.entity.functions.js"
import { BucketNumber } from "./vote.entity.js"
import type { Bucket } from "./vote.entity.js"

const finding = (path: string, line: number, severity: Finding["severity"], number: number, more: Partial<Finding> = {}): Finding =>
  ({ path, line, kind: "bug", severity, claim: `Claim ${number}.`, evidence: `line ${line}\nnext`, pass: PassNumber.make(1), number, ...more })

const FINDINGS = [
  finding("src/z.ts", 9, "low", 1), finding("src/sum.ts", 4, "high", 2), finding("src/a.ts", 3, "medium", 3, { endLine: 5, kind: "security" }),
  finding("src/a.ts", 1, "medium", 4), finding("b.ts", 2, "low", 5), finding("c.ts", 2, "low", 6), finding("d.ts", 2, "low", 7),
  finding("e.ts", 2, "high", 8), finding("f.ts", 2, "high", 9), finding("g.ts", 2, "high", 10),
]

/** One bucket per finding, numbered as found, with `votes` passes. */
const BUCKETS: ReadonlyArray<Bucket> = FINDINGS.map((one, index) => ({
  number: BucketNumber.make(index + 1), path: one.path, kind: one.kind, line: one.line, endLine: one.endLine ?? one.line,
  members: [{ pass: one.pass, number: one.number }], votes: index === 1 ? 3 : 1, best: one, kept: true, why: "kept",
}))

/** A check of bucket `index + 1`: confirmed for the first seven, then refuted, unsure (its quote not found) and unchecked. */
const CHECKS: ReadonlyArray<BucketCheck> = BUCKETS.map((bucket, index): BucketCheck => {
  const check = CheckNumber.make(index + 1)
  const given = (outcome: "confirmed" | "refuted") => Option.some({ outcome, reason: `Reason ${index + 1}.`, quote: "q", check })
  if (index < 7) return { bucket: bucket.number, finding: bucket.members[0] ?? { pass: PassNumber.make(1), number: 1 }, check, verdict: given("confirmed"), quoteHolds: true, outcome: "confirmed", why: "" }
  if (index === 7) return { bucket: bucket.number, finding: bucket.members[0] ?? { pass: PassNumber.make(1), number: 1 }, check, verdict: given("refuted"), quoteHolds: true, outcome: "refuted", why: "" }
  if (index === 8) return { bucket: bucket.number, finding: bucket.members[0] ?? { pass: PassNumber.make(1), number: 1 }, check, verdict: given("confirmed"), quoteHolds: false, outcome: "unsure", why: "its quote is not in the file near the cited lines" }
  return { bucket: bucket.number, finding: bucket.members[0] ?? { pass: PassNumber.make(1), number: 1 }, check, verdict: Option.none(), quoteHolds: false, outcome: "unchecked", why: "the spend cap refused a model call" }
})

const passResult = (number: number, ended: PassResult["ended"], cost: number): PassResult => ({
  stage: { _tag: "Find", pass: PassNumber.make(number) },
  session: Option.some(SessionId.make(`s-${number}`)),
  ended,
  calls: [{ step: 1, tokens: Option.some({ input: 30_000, cached: 0, output: 900 }), cost }, { step: 2, tokens: Option.some({ input: 31_000, cached: 29_952, output: 400 }), cost: 0.0008 }],
  opened: number === 1 ? ["src/a.ts", "src/sum.ts"] : ["src/sum.ts"],
})

const CHECK_RESULT: PassResult = {
  stage: { _tag: "Verify", check: CheckNumber.make(1) },
  session: Option.some(SessionId.make("c-1")),
  ended: { _tag: "Judged" },
  calls: [{ step: 1, tokens: Option.some({ input: 30_000, cached: 29_000, output: 200 }), cost: 0.0005 }],
  opened: ["src/z.ts"],
}

const INPUT: Parameters<typeof reviewReport>[0] = {
  run: runNameOf(Date.UTC(2026, 10, 19, 22, 1, 51, 123)),
  prepared: PREPARED,
  focus: "whole",
  effort: { find: "default", check: "default" },
  groups: [],
  ungrouped: [],
  notes: [],
  finder: "candidates",
  vote: false,
  verify: true,
  complete: true,
  passesAsked: 3,
  passes: [passResult(1, { _tag: "Answered", summary: "Seven problems." }, 0.0101), passResult(2, { _tag: "StepCap", steps: 16, summary: "Two more.", why: "" }, 0.0011), passResult(3, { _tag: "OutputCut" }, 0.0011)],
  checks: [CHECK_RESULT],
  findings: FINDINGS,
  buckets: [...BUCKETS, { ...BUCKETS[0]!, number: BucketNumber.make(11), kept: false, why: "off-changed-lines" }],
  verdicts: CHECKS,
  promptVersion: "review-prompt-3",
  toolsVersion: "review-tools-3",
  model: "deepseek/deepseek-v4.1-flash-1017",
  wallMs: 41_250,
}

const REPORT = reviewReport(INPUT)

describe("the review's report", () => {
  test("reportText: six confirmed findings by severity then path then line, each with its evidence, votes and the check's reason, the rest counted; the passes, buckets, checks, files, each stage's use and the wall time", () => {
    expect(reportText(REPORT)).toBe([
      "Review of #7 in owner/project at bbbbbbbbbbbb, its head",
      "",
      "src/sum.ts:4 high bug — Claim 2. (3/3 passes) (restates a CI failure)",
      "    > line 4",
      "    > next",
      "    checked: Reason 2.",
      "src/a.ts:1 medium bug — Claim 4. (1/3 passes)",
      "    > line 1",
      "    > next",
      "    checked: Reason 4.",
      "src/a.ts:3-5 medium security — Claim 3. (1/3 passes)",
      "    > line 3",
      "    > next",
      "    checked: Reason 3.",
      "b.ts:2 low bug — Claim 5. (1/3 passes)",
      "    > line 2",
      "    > next",
      "    checked: Reason 5.",
      "c.ts:2 low bug — Claim 6. (1/3 passes)",
      "    > line 2",
      "    > next",
      "    checked: Reason 6.",
      "d.ts:2 low bug — Claim 7. (1/3 passes)",
      "    > line 2",
      "    > next",
      "    checked: Reason 7.",
      "1 more finding not shown.",
      "",
      "Unsettled: no check confirmed these and none refuted them (a check could not tell, or its quote was not found); read them before trusting either way.",
      "f.ts:2 high bug — Claim 9. (1/3 passes)",
      "    > line 2",
      "    > next",
      "    checked: its quote is not in the file near the cited lines: Reason 9.",
      "Not checked (the spend cap refused a model call): g.ts:2 high bug — Claim 10.",
      "",
      "Pass 1: Seven problems.",
      "Pass 2: incomplete: the pass reached its step cap (16); Two more.",
      "Pass 3: incomplete: an answer was cut at the output cap",
      "Passes: 3, finding candidates; buckets: 10 kept, 0 left out by the vote, 1 off the changed lines",
      "Checks: 7 confirmed, 1 refuted, 1 unsure, 1 unchecked",
      "Files: 1 in the pack of 2 changed; opened 2: src/a.ts, src/sum.ts",
      "Find: 6 calls, 183000 tokens in (49% cached), 3900 out, $0.0147; verify: 1 call, 30000 tokens in (97% cached), 200 out, $0.0005",
      "Model: deepseek/deepseek-v4.1-flash-1017; 7 calls, 213000 tokens in (56% cached), 4100 out, $0.0152; wall 41.3 s",
    ].join("\n"))
  })

  test("reportText: no findings, and a pass that stopped before it answered says why; the passes it kept from starting are said", () => {
    const answered = { ...REPORT, reported: [], unsettled: [], verdicts: [], passesAsked: 1, passes: REPORT.passes.slice(0, 1) }
    expect(reportText(answered).split("\n").filter((line) => line === "No findings." || line.includes("did not start"))).toEqual(["No findings."])
    const stopped = { ...REPORT, reported: [], unsettled: [], verdicts: [], passes: REPORT.passes.slice(0, 1).map((one) => ({ ...one, ended: { _tag: "SpendRefused" as const, message: "the ledger's total cap of 0.1 refused 0.04" } })) }
    expect(reportText(stopped).split("\n").slice(0, 6)).toEqual([
      "Review of #7 in owner/project at bbbbbbbbbbbb, its head",
      "",
      "Incomplete: no pass finished.",
      "",
      "Pass 1: incomplete: the spend cap refused a model call: the ledger's total cap of 0.1 refused 0.04",
      "Passes 2 to 3 did not start: the find stage stopped because pass 1 ended before its first call answered.",
    ])
    expect(reportText({ ...stopped, passesAsked: 2 }).split("\n")[5]).toBe("Pass 2 did not start: the find stage stopped because pass 1 ended before its first call answered.")
  })

  test("reportText: a focused review's groups, each with its pass, cost and findings or why it was not reviewed, its files and the efforts", () => {
    const group = (number: number, paths: ReadonlyArray<string>) => ({ number: GroupNumber.make(number), package: "packages/app", paths, tokens: 900 })
    const focused = {
      ...REPORT,
      focus: "groups" as const,
      effort: { find: "none" as const, check: "default" as const },
      passesAsked: 2,
      passes: REPORT.passes.slice(0, 2),
      groups: [
        { group: group(1, ["src/a.ts", "src/a.test.ts"]), pass: Option.some(PassNumber.make(1)), notReviewed: "" },
        { group: group(2, ["src/sum.ts"]), pass: Option.some(PassNumber.make(2)), notReviewed: "" },
        { group: group(3, ["src/y.ts"]), pass: Option.some(PassNumber.make(3)), notReviewed: noCallWhy({ _tag: "SpendRefused", message: "the cap of 0.3 refused 0.04" }) },
        { group: group(4, ["src/z.ts"]), pass: Option.none(), notReviewed: NOT_REVIEWED_BECAUSE.stopped },
        { group: group(5, ["src/x.ts"]), pass: Option.none(), notReviewed: NOT_REVIEWED_BECAUSE.spent },
      ],
      ungrouped: [{ path: "package.json", why: "a manifest or CI file" }, { path: "README.md", why: "docs" }],
      notes: [lookupFailedNote("packages/app")],
    }
    const lines = reportText(focused).split("\n")
    expect(lines.slice(lines.indexOf("Pass 1: Seven problems."))).toEqual([
      "Pass 1: Seven problems.",
      "Pass 2: incomplete: the pass reached its step cap (16); Two more.",
      "Group 1 (packages/app, 2 files): pass 1, $0.0109, 10 findings",
      "Group 2 (packages/app, 1 file): pass 2, $0.0019, 0 findings",
      "Group 3 (packages/app, 1 file): pass 3, not reviewed: its pass ended before any model call answered: the cap of 0.3 refused 0.04",
      "Group 4 (packages/app, 1 file): not reviewed: the find stage refused an earlier group's pass before any of its calls answered, so it stopped",
      "Group 5 (packages/app, 1 file): not reviewed: the find stage had no room for its first call and its closing reserve",
      "In no group: package.json (a manifest or CI file)",
      "In no group: README.md (docs)",
      "Note: The package.json of packages/app could not be looked up, so its files were grouped as if it held none.",
      "Passes: 2, finding candidates; buckets: 10 kept, 0 left out by the vote, 1 off the changed lines",
      "Checks: 7 confirmed, 1 refuted, 1 unsure, 1 unchecked",
      "Files: 6 in 5 groups of 2 changed; opened 2: src/a.ts, src/sum.ts",
      "Find: 6 calls, 183000 tokens in (49% cached), 3900 out, $0.0147; verify: 1 call, 30000 tokens in (97% cached), 200 out, $0.0005",
      "Model: deepseek/deepseek-v4.1-flash-1017; effort: find none, check default; 7 calls, 213000 tokens in (56% cached), 4100 out, $0.0152; wall 41.3 s",
    ])
  })

  test("reportText: a closing call that failed and a pass that could not run say why", () => {
    const ended = [{ _tag: "StepCap" as const, steps: 16, summary: "", why: "the key is wrong" }, { _tag: "Failed" as const, message: "the disk is full" }]
    const report = { ...REPORT, passesAsked: 2, passes: ended.map((one, index) => ({ ...passResult(index + 1, one, 0) })) }
    expect(reportText(report).split("\n").filter((line) => line.startsWith("Pass "))).toEqual([
      "Pass 1: incomplete: the pass reached its step cap (16); its closing call failed: the key is wrong",
      "Pass 2: incomplete: the pass could not run: the disk is full",
    ])
  })

  test("reportText: with no check run, the kept buckets' findings are shown and the checks said to be none", () => {
    const unchecked = reviewReport({ ...{ run: REPORT.run, prepared: PREPARED, focus: "whole", effort: REPORT.effort, groups: [], ungrouped: [], notes: [], finder: "strict", vote: true, verify: false, complete: true, passesAsked: 1, checks: [], findings: FINDINGS, verdicts: [] }, passes: REPORT.passes.slice(0, 1), buckets: BUCKETS.slice(0, 2), promptVersion: "p", toolsVersion: "t", model: "m", wallMs: 1 })
    const lines = reportText(unchecked).split("\n")
    expect([lines[2], lines.find((line) => line.startsWith("Passes")), lines.find((line) => line.startsWith("Checks"))]).toEqual([
      "src/sum.ts:4 high bug — Claim 2. (3/1 pass) (restates a CI failure)", "Passes: 1, finding strictly; buckets: 2 kept, 0 left out by the vote, 0 off the changed lines", "Checks: none run",
    ])
  })

  test("reportText: the model's claim, evidence, reason and summary are printed plain, escape sequences and control characters stripped", () => {
    const sneaky = finding("src/a.ts", 3, "high", 1, { claim: "Bad\u001b[2J\u001b[31m red\u0007 claim.", evidence: "ok\u001b]8;;http://x\u0007link\u001b]8;;\u0007 line" })
    const report = { ...REPORT, verdicts: [], unsettled: [], reported: [{ ...sneaky, bucket: BucketNumber.make(1), votes: 1, checked: "Real\u001b[1A.", restatesCi: false }], passes: REPORT.passes.slice(0, 1).map((one) => ({ ...one, ended: { _tag: "Answered" as const, summary: "Done\u001b[1A\rover" } })) }
    expect(reportText(report).split("\n").slice(2, 7)).toEqual([
      "src/a.ts:3 high bug — Bad red claim. (1/1 pass)",
      "    > oklink line",
      "    checked: Real.",
      "",
      "Pass 1: Doneover",
    ])
  })

  test("reportText: a kept bucket no check gave a verdict on is listed, never read as no finding", () => {
    const none = { ...REPORT, reported: [], unsettled: [] }
    expect(reportText(none).split("\n").slice(2, 4)).toEqual(["No findings.", "Not checked (the spend cap refused a model call): g.ts:2 high bug — Claim 10."])
  })

  test("reportText: findings no check settled are shown apart, under their own line, never as no finding", () => {
    // Bucket 9's check confirmed it but its quote was not found, so the host made it unsure and says why first.
    expect<unknown>([REPORT.unsettled.map((one) => [one.bucket, one.claim, one.checked]), reportText({ ...REPORT, reported: [], verdicts: [] }).split("\n").slice(2, 10)]).toEqual([
      [[9, "Claim 9.", "its quote is not in the file near the cited lines: Reason 9."]],
      [
        "No confirmed findings.",
        "",
        "Unsettled: no check confirmed these and none refuted them (a check could not tell, or its quote was not found); read them before trusting either way.",
        "f.ts:2 high bug — Claim 9. (1/3 passes)",
        "    > line 2",
        "    > next",
        "    checked: its quote is not in the file near the cited lines: Reason 9.",
        "",
      ],
    ])
  })

  test("reviewReport: a bucket a check confirmed is never unsettled, whatever another of its checks said", () => {
    const bucket = BUCKETS[8]!
    const second = { pass: PassNumber.make(2), number: 1 }
    const both = reviewReport({ ...INPUT, findings: [...FINDINGS, finding("f.ts", 2, "high", 1, { pass: second.pass, claim: "Claim 9b." })], verdicts: [
      ...CHECKS, { bucket: bucket.number, finding: second, check: CheckNumber.make(11), verdict: Option.none(), quoteHolds: true, outcome: "confirmed", why: "" },
    ] })
    expect([both.unsettled, both.reported.filter((one) => one.bucket === bucket.number).map((one) => one.claim)]).toEqual([[], ["Claim 9b."]])
  })

  test("runNameOf: a run named by the UTC time it started, safe in a folder's name", () => {
    expect(REPORT.run).toBe("2026-11-19T22-01-51-123Z")
  })

  test("the record: every finding, bucket and check kept; the reported ones confirmed and sorted; each stage's and the total use added up", () => {
    expect([REPORT.findings.length, REPORT.buckets.length, REPORT.verdicts.length, REPORT.reported.map((one) => one.number), REPORT.stages, REPORT.usage, REPORT.packedFiles, REPORT.changedFiles, REPORT.wallMs]).toEqual([
      10, 11, 10, [2, 4, 3, 5, 6, 7, 1],
      { find: { input: 183_000, cached: 89_856, output: 3_900, cost: 0.0147, calls: 6 }, verify: { input: 30_000, cached: 29_000, output: 200, cost: 0.0005, calls: 1 } },
      { input: 213_000, cached: 118_856, output: 4_100, cost: 0.0152, calls: 7 }, 1, 2, 41_250,
    ])
  })

  test("restatesCi: a failure that names the path at one of the finding's lines, as path:line or path(line,", () => {
    expect([
      restatesCi(finding("src/sum.ts", 4, "low", 1), PREPARED.failing),
      restatesCi(finding("src/sum.ts", 2, "low", 1, { endLine: 4 }), PREPARED.failing),
      restatesCi(finding("src/sum.ts", 3, "low", 1), PREPARED.failing),
      restatesCi(finding("sum.ts", 40, "low", 1), PREPARED.failing),
      restatesCi(finding("src/other.ts", 4, "low", 1), PREPARED.failing),
    ]).toEqual([true, true, false, false, false])
  })
})
