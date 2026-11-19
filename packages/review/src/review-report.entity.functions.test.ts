import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { SessionId } from "@xandreed/core"
import { PassNumber } from "./finding.entity.js"
import type { Finding } from "./finding.entity.js"
import { PREPARED } from "./review-prompt.testing.js"
import { reportText, restatesCi, reviewReport, runNameOf } from "./review-report.entity.functions.js"

const pass = PassNumber.make(1)
const finding = (path: string, line: number, severity: Finding["severity"], number: number, more: Partial<Finding> = {}): Finding =>
  ({ path, line, kind: "bug", severity, claim: `Claim ${number}.`, evidence: `line ${line}\nnext`, pass, number, ...more })

const FINDINGS = [
  finding("src/z.ts", 9, "low", 1), finding("src/sum.ts", 4, "high", 2), finding("src/a.ts", 3, "medium", 3, { endLine: 5, kind: "security" }),
  finding("src/a.ts", 1, "medium", 4), finding("b.ts", 2, "low", 5), finding("c.ts", 2, "low", 6), finding("d.ts", 2, "low", 7),
]

const REPORT = reviewReport({
  run: runNameOf(Date.UTC(2026, 10, 19, 22, 1, 51, 123)),
  prepared: PREPARED,
  passes: [{
    pass,
    session: Option.some(SessionId.make("s-1")),
    ended: { _tag: "Answered", summary: "Seven problems." },
    calls: [{ step: 1, tokens: Option.some({ input: 30_000, cached: 0, output: 900 }), cost: 0.0101 }, { step: 2, tokens: Option.some({ input: 31_000, cached: 29_952, output: 400 }), cost: 0.0008 }],
    opened: ["src/a.ts", "src/sum.ts"],
  }],
  findings: FINDINGS,
  promptVersion: "review-prompt-1",
  toolsVersion: "review-tools-1",
  model: "deepseek/deepseek-v4.1-flash-1017",
  wallMs: 41_250,
})

describe("the review's report", () => {
  test("reportText: six findings by severity then path then line, each with its evidence, the rest counted; the pass, the files, the calls, tokens, cost and wall time", () => {
    expect(reportText(REPORT)).toBe([
      "Review of #7 in owner/project at bbbbbbbbbbbb, its head",
      "",
      "src/sum.ts:4 high bug — Claim 2. (restates a CI failure)",
      "    > line 4",
      "    > next",
      "src/a.ts:1 medium bug — Claim 4.",
      "    > line 1",
      "    > next",
      "src/a.ts:3-5 medium security — Claim 3.",
      "    > line 3",
      "    > next",
      "b.ts:2 low bug — Claim 5.",
      "    > line 2",
      "    > next",
      "c.ts:2 low bug — Claim 6.",
      "    > line 2",
      "    > next",
      "d.ts:2 low bug — Claim 7.",
      "    > line 2",
      "    > next",
      "1 more finding not shown.",
      "",
      "Pass 1: Seven problems.",
      "Files: 1 in the pack of 2 changed; opened 2: src/a.ts, src/sum.ts",
      "Model: deepseek/deepseek-v4.1-flash-1017; 2 calls; tokens 61000 in (29952 cached, 49%), 1300 out; cost $0.0109; wall 41.3 s",
    ].join("\n"))
  })

  test("reportText: no findings, and a pass that stopped before it answered says why", () => {
    const stopped = { ...REPORT, findings: [], passes: REPORT.passes.map((one) => ({ ...one, ended: { _tag: "SpendRefused" as const, message: "the ledger's total cap of 0.1 refused 0.04" } })) }
    expect(reportText(stopped).split("\n").slice(0, 5)).toEqual([
      "Review of #7 in owner/project at bbbbbbbbbbbb, its head",
      "",
      "No findings.",
      "",
      "Pass 1: incomplete: the spend cap refused a model call: the ledger's total cap of 0.1 refused 0.04",
    ])
    const cut = { ...REPORT, passes: REPORT.passes.map((one) => ({ ...one, ended: { _tag: "OutputCut" as const } })) }
    expect(reportText(cut).split("\n").find((line) => line.startsWith("Pass 1"))).toBe("Pass 1: incomplete: an answer was cut at the output cap")
  })

  test("reportText: the model's claim, evidence and summary are printed plain, escape sequences and control characters stripped", () => {
    const sneaky = finding("src/a.ts", 3, "high", 1, { claim: "Bad\u001b[2J\u001b[31m red\u0007 claim.", evidence: "ok\u001b]8;;http://x\u0007link\u001b]8;;\u0007 line" })
    const report = { ...REPORT, findings: [{ ...sneaky, restatesCi: false }], passes: REPORT.passes.map((one) => ({ ...one, ended: { _tag: "Answered" as const, summary: "Done\u001b[1A\rover" } })) }
    expect(reportText(report).split("\n").slice(2, 6)).toEqual([
      "src/a.ts:3 high bug — Bad red claim.",
      "    > oklink line",
      "",
      "Pass 1: Doneover",
    ])
  })

  test("runNameOf: a run named by the UTC time it started, safe in a folder's name", () => {
    expect(REPORT.run).toBe("2026-11-19T22-01-51-123Z")
  })

  test("the record's totals: every call's tokens and cost added up", () => {
    expect([REPORT.usage, REPORT.packedFiles, REPORT.changedFiles, REPORT.wallMs, REPORT.findings.map((one) => one.number)]).toEqual([
      { input: 61_000, cached: 29_952, output: 1_300, cost: 0.0109 }, 1, 2, 41_250, [2, 4, 3, 5, 6, 7, 1],
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
