import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Option } from "effect"
import type { Pack, PackReport } from "./model.js"
import type { Baseline } from "./baseline.js"
import {
  compareBaseline,
  orphanedEntries,
  readBaseline,
  toBaseline,
  unbaselinedEntries,
  versionDrift,
  writeBaseline,
} from "./baseline.js"

const report = (over: Partial<PackReport> = {}): PackReport => ({
  pack: "toy",
  mode: "live",
  scenarios: [
    { name: "a", status: "ran", hardPassed: true, checks: [], judges: [], score: 1, combined: 0.9 },
    { name: "skipped", status: "skipped", hardPassed: false, checks: [], judges: [], score: 0, combined: 0 },
  ],
  mean: 0.9,
  threshold: 0.8,
  passed: true,
  ...over,
})

const pack = (over: Partial<Pack> = {}): Pack => ({
  name: "toy",
  threshold: 0.8,
  scenarios: [],
  ...over,
})

describe("the baseline module", () => {
  test("write → read round-trip carries versions/samples/mintedAt; skipped scenarios excluded", () => {
    const dir = mkdtempSync(join(tmpdir(), "baseline-"))
    writeBaseline(dir, report(), pack({ meta: { "judge-prompt": "1.0.0" }, samples: 3 }))
    const loaded = Option.getOrThrow(readBaseline(dir, "toy", "live"))
    expect(loaded.mean).toBe(0.9)
    expect(loaded.scenarios).toEqual({ a: 0.9 })
    expect(loaded.versions).toEqual({ "judge-prompt": "1.0.0" })
    expect(loaded.samples).toBe(3)
    expect(loaded.mintedAt).toBeDefined()
  })

  test("absent file → None; no throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "baseline-"))
    expect(Option.isNone(readBaseline(dir, "nope", "live"))).toBe(true)
  })

  test("compareBaseline: regression only beyond the tolerance, one-directional", () => {
    const base = toBaseline(report({ mean: 0.9 }), pack())
    expect(Option.isNone(compareBaseline(report({ mean: 0.87 }), base, 0.05))).toBe(true)
    expect(Option.isSome(compareBaseline(report({ mean: 0.84 }), base, 0.05))).toBe(true)
    // Improvements never fail.
    expect(Option.isNone(compareBaseline(report({ mean: 1.0 }), base, 0.05))).toBe(true)
    // A looser per-pack tolerance absorbs a bigger drop.
    expect(Option.isNone(compareBaseline(report({ mean: 0.84 }), base, 0.1))).toBe(true)
  })

  test("versionDrift: fires on changed and removed MINTED keys; new keys are grandfathered", () => {
    const minted = toBaseline(report(), pack({ meta: { "judge-prompt": "1.0.0" } }))
    expect(Option.isNone(versionDrift(pack({ meta: { "judge-prompt": "1.0.0" } }), minted))).toBe(true)
    const changed = versionDrift(pack({ meta: { "judge-prompt": "1.1.0" } }), minted)
    expect(Option.getOrThrow(changed)).toContain("judge-prompt 1.0.0")
    expect(Option.getOrThrow(changed)).toContain("judge-prompt 1.1.0")
    expect(Option.isSome(versionDrift(pack({ meta: {} }), minted))).toBe(true)
    // A provenance key added SINCE the mint (e.g. model ids landing after
    // the first mint) is new information, not drift — it rides in on the
    // next legitimate re-mint instead of nagging every run.
    expect(
      Option.isNone(
        versionDrift(
          pack({ meta: { "judge-prompt": "1.0.0", "model.code": "opencode:kimi-k2.7-code" } }),
          minted,
        ),
      ),
    ).toBe(true)
    // Old baselines without versions never drift against a meta-less pack.
    const bare = toBaseline(report(), pack())
    expect(Option.isNone(versionDrift(pack(), bare))).toBe(true)
  })

  test("writeBaseline: a no-op re-mint keeps the original mintedAt (no diff churn)", () => {
    const dir = mkdtempSync(join(tmpdir(), "baseline-"))
    writeBaseline(dir, report(), pack({ meta: { v: "1" } }))
    const first = Option.getOrThrow(readBaseline(dir, "toy", "live"))
    writeBaseline(dir, report(), pack({ meta: { v: "1" } }))
    expect(Option.getOrThrow(readBaseline(dir, "toy", "live")).mintedAt).toBe(first.mintedAt!)
    // A REAL change writes through.
    writeBaseline(dir, report({ mean: 0.95 }), pack({ meta: { v: "1" } }))
    expect(Option.getOrThrow(readBaseline(dir, "toy", "live")).mean).toBe(0.95)
  })

  test("orphanedEntries: names a baseline entry no scenario carries anymore; skipped counts as present", () => {
    const baseline: Baseline = {
      mode: "live",
      mean: 0.9,
      scenarios: { "old-name": 1.0, a: 0.9, skipped: 1.0 },
    }
    const warnings = orphanedEntries(report(), baseline)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('"old-name"')
  })

  test("unbaselinedEntries rejects a newly added ran scenario", () => {
    const baseline: Baseline = { mode: "live", mean: 0.9, scenarios: { a: 0.9 } }
    const additions = unbaselinedEntries(
      report({
        scenarios: [
          { name: "a", status: "ran", hardPassed: true, checks: [], judges: [], score: 1, combined: 1 },
          { name: "new", status: "ran", hardPassed: true, checks: [], judges: [], score: 1, combined: 1 },
        ],
      }),
      baseline,
    )
    expect(additions).toHaveLength(1)
    expect(additions[0]).toContain('"new"')
  })

  test("perScenario ratchet: a case drop fails even when the mean holds", () => {
    const baseline: Baseline = {
      mode: "live",
      mean: 0.9,
      scenarios: { "case-a": 1.0, "case-b": 0.8 },
    }
    const report: PackReport = {
      pack: "p",
      mode: "live",
      mean: 0.9,
      threshold: 0.5,
      passed: true,
      scenarios: [
        { name: "case-a", status: "ran", hardPassed: true, checks: [], judges: [], score: 0.7, combined: 0.7 },
        { name: "case-b", status: "ran", hardPassed: true, checks: [], judges: [], score: 1.1, combined: 1.1 },
      ],
    }
    // Mean-only: fine (0.9 ≥ 0.9 − 0.05).
    expect(Option.isNone(compareBaseline(report, baseline, 0.05))).toBe(true)
    // Per-scenario: case-a dropped 1.0 → 0.7.
    const caught = Option.getOrThrow(compareBaseline(report, baseline, 0.05, true))
    expect(caught).toContain("case-a")
    expect(caught).not.toContain("case-b")
    // A looser PER-SCENARIO tolerance absorbs the case drop (a k-sampled
    // case moves in 1/k steps) while the mean gate keeps its own.
    expect(Option.isNone(compareBaseline(report, baseline, 0.05, true, 0.34))).toBe(true)
    // Skipped results and unminted cases never ratchet.
    const withSkip: PackReport = {
      ...report,
      scenarios: [
        { name: "case-a", status: "skipped", hardPassed: false, checks: [], judges: [], score: 0, combined: 0 },
        { name: "brand-new", status: "ran", hardPassed: true, checks: [], judges: [], score: 0.1, combined: 0.1 },
      ],
    }
    expect(Option.isNone(compareBaseline(withSkip, baseline, 0.05, true))).toBe(true)
  })
})
