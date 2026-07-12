import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import type { Pack, PackReport } from "./model.js"
import { defaultExtras, renderReport } from "./report.js"

const report: PackReport = {
  pack: "toy",
  mode: "live",
  scenarios: [
    {
      name: "sound:case",
      status: "ran",
      hardPassed: false,
      checks: [
        { step: "s1", check: "verdict", severity: "hard", pass: false, detail: "judged unsound" },
      ],
      judges: [{ judge: "spec-quality", score: 0.75, reason: "acceptance #3 vague" }],
      score: 0.5,
      combined: 0.6,
      samples: {
        count: 3,
        scores: [1, 0, 0.8],
        passRate: 2 / 3,
        passRate95: { low: 0.2077, high: 0.9385 },
        passAtK: 26 / 27,
        passAllK: 8 / 27,
        infraFailures: 0,
        outcomes: [],
      },
    },
  ],
  mean: 0.6,
  threshold: 0.8,
  passed: false,
}

const pack: Pack = {
  name: "toy",
  threshold: 0.8,
  samples: 3,
  meta: { "judge-prompt": "1.0.0" },
  scenarios: [],
}

describe("renderReport", () => {
  test("scripted shape unchanged: no judges, no meta for meta-less packs", () => {
    const first = report.scenarios[0]!
    const bare = renderReport(
      {
        ...report,
        scenarios: [
          {
            name: first.name,
            status: first.status,
            hardPassed: first.hardPassed,
            checks: first.checks,
            judges: [],
            score: first.score,
            combined: first.combined,
          },
        ],
      },
      { name: "toy", threshold: 0.8, scenarios: [] },
    )
    expect(bare).toContain("pack toy (live) — mean 0.600 / threshold 0.8 — FAIL")
    expect(bare).not.toContain("⚖")
    expect(bare).not.toContain("[judge-prompt")
  })

  test("live extras: version header, samples tag, judge lines, summary, regression + drift", () => {
    const out = renderReport(report, pack, {
      regression: Option.some("REGRESSION vs committed baseline"),
      drift: Option.some("baseline minted for judge-prompt 0.9.0"),
      showJudges: true,
      summary: ["false-block 0.06 · false-pass 0.17"],
    })
    expect(out).toContain("[judge-prompt 1.0.0 · k=3]")
    expect(out).toContain("(p 67% [21–94] · pass@3 96% · pass^3 30%)")
    expect(out).toContain("⚖ spec-quality 0.75 — acceptance #3 vague")
    expect(out).toContain("false-block 0.06")
    expect(out).toContain("⚠ REGRESSION")
    expect(out).toContain("⚠ baseline minted")
    expect(out).toContain("✗ [hard] s1 › verdict — judged unsound")
  })

  test("defaultExtras renders without judge/summary noise", () => {
    const out = renderReport(report, pack, defaultExtras)
    expect(out).not.toContain("⚖")
    expect(out).not.toContain("false-block")
  })
})
