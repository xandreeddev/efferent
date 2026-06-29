import { describe, expect, it } from "bun:test"
import type { Candidate, GateInput } from "@xandreed/sdk-core"
import { gateJudgePrompt, refuteJudgePrompt, toDeliverable } from "./structured.js"

describe("toDeliverable — prose preserved as feedback", () => {
  it("sound → no feedback (nothing to retry)", () => {
    const v = toDeliverable({ verdict: "sound", assessment: "all good", reasons: [] })
    expect(v.verdict).toBe("sound")
    expect(v.reasons).toEqual([])
  })

  it("needs_work → the full prose assessment LEADS, then the actionable reasons", () => {
    const v = toDeliverable({
      verdict: "needs_work",
      assessment: "The research never validated the gate path end-to-end.",
      reasons: ["add a test for the gate", "  ", "check the headless mode"],
    })
    expect(v.verdict).toBe("needs_work")
    // assessment first (full reasoning), empties trimmed out
    expect(v.reasons).toEqual([
      "The research never validated the gate path end-to-end.",
      "add a test for the gate",
      "check the headless mode",
    ])
  })

  it("blocked → also carries the assessment so the caller sees why", () => {
    const v = toDeliverable({ verdict: "blocked", assessment: "task is contradictory", reasons: [] })
    expect(v.verdict).toBe("blocked")
    expect(v.reasons).toEqual(["task is contradictory"])
  })
})

describe("gateJudgePrompt", () => {
  const base: GateInput = { task: "T", summary: "S", filesChanged: [], repoDir: "/r" }

  it("prose deliverable (no files) judges the answer + sources, includes task/summary", () => {
    const p = gateJudgePrompt(base, "")
    expect(p).toContain("<task>\nT\n</task>")
    expect(p).toContain("<summary>\nS\n</summary>")
    expect(p).toContain("SUPPORTED")
    expect(p).not.toContain("Files changed:")
  })

  it("code deliverable embeds the changed-file contents (ground truth, not the summary)", () => {
    const p = gateJudgePrompt({ ...base, filesChanged: ["a.ts"] }, '\n<file path="a.ts">\ncode\n</file>')
    expect(p).toContain("Files changed: a.ts")
    expect(p).toContain('<file path="a.ts">')
    expect(p).toContain("check against them, not the summary")
  })
})

describe("refuteJudgePrompt", () => {
  const cand: Candidate = {
    kind: "constraint",
    name: "use-const",
    description: "prefer const",
    body: "use const not let",
    scope: "global",
    source: "inferred",
    evidence: { conversationId: "c", positions: [1] },
  }
  it("frames refutation, names the candidate, lists existing learnings", () => {
    const p = refuteJudgePrompt(cand, { repoDir: "/r", existing: ["always run typecheck"] })
    expect(p).toContain("REFUTE")
    expect(p).toContain("use-const")
    expect(p).toContain("always run typecheck")
  })
})
