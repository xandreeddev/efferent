import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildReport, readReport, reportExists, writeReport } from "./storage.js"
import type { RunAgg } from "./trace/process.js"

const sampleRuns: ReadonlyArray<RunAgg> = [
  {
    configName: "test",
    suites: [
      {
        suite: "quality",
        mean: 0.7,
        passRate: 0.8,
        cases: [
          {
            suite: "quality",
            name: "c1",
            configName: "test",
            ok: true,
            mean: 0.7,
            samples: 3,
            stdev: 0.05,
            scores: [{ name: "quality", score: 0.7 }],
            steps: 4,
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 0,
            wallMs: 1000,
          },
        ],
      },
    ],
  },
]

describe("storage — committable baseline round-trip", () => {
  it("writes a dated, git-stamped report and reads it back intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-store-"))
    try {
      const path = join(dir, "nested", "baseline.json")
      const report = buildReport(sampleRuns, "2026-06-25T00:00:00.000Z", "abc1234", "baseline")
      expect(reportExists(path)).toBe(false)
      writeReport(path, report) // also creates the parent dir
      expect(reportExists(path)).toBe(true)

      const back = readReport(path)
      expect(back.version).toBe(1)
      expect(back.ts).toBe("2026-06-25T00:00:00.000Z")
      expect(back.gitSha).toBe("abc1234")
      expect(back.label).toBe("baseline")
      expect(back.runs[0]!.suites[0]!.mean).toBeCloseTo(0.7)
      expect(back.runs[0]!.suites[0]!.cases[0]!.samples).toBe(3)
      expect(back.runs[0]!.suites[0]!.cases[0]!.stdev).toBeCloseTo(0.05)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
