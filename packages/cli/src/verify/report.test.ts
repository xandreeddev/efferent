import { test, expect } from "bun:test"
import { exitCodeFor, formatReport, reportPassed, type CheckResult, type VerifyReport } from "./report.js"

const mk = (checks: CheckResult[]): VerifyReport => ({
  target: "source",
  model: "opencode:deepseek-v4-flash",
  checks,
})

test("a hard fail flips the verdict + exit code; soft/skip do not", () => {
  const softSkipPass = mk([
    { name: "boot", tier: "A", status: "pass", ms: 1 },
    { name: "evals", tier: "C", status: "soft", ms: 1 },
    { name: "daemon-turn", tier: "B", status: "skip", ms: 1 },
  ])
  expect(reportPassed(softSkipPass)).toBe(true)
  expect(exitCodeFor(softSkipPass)).toBe(0)

  const withFail = mk([...softSkipPass.checks, { name: "gate", tier: "A", status: "fail", ms: 1 }])
  expect(reportPassed(withFail)).toBe(false)
  expect(exitCodeFor(withFail)).toBe(1)
})

test("formatReport groups by tier and surfaces the summary", () => {
  const text = formatReport(
    mk([
      { name: "boot:version", tier: "A", status: "pass", detail: "version 0.2.0", ms: 12 },
      { name: "code-turn", tier: "B", status: "skip", detail: "no credential", ms: 0 },
    ]),
  )
  expect(text).toContain("Tier A")
  expect(text).toContain("Tier B")
  expect(text).toContain("boot:version")
  expect(text).toContain("1 ok")
  expect(text).toContain("1 skip")
})
