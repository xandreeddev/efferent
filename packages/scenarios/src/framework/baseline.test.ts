import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Option } from "effect"
import type { Pack, PackReport } from "./model.js"
import {
  compareBaseline,
  readBaseline,
  toBaseline,
  versionDrift,
  writeBaseline,
} from "./baseline.js"

const report = (over: Partial<PackReport> = {}): PackReport => ({
  pack: "toy",
  mode: "live",
  scenarios: [
    { name: "a", status: "ran", checks: [], judges: [], score: 1, combined: 0.9 },
    { name: "skipped", status: "skipped", checks: [], judges: [], score: 0, combined: 0 },
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

  test("versionDrift: fires on changed, added, and removed keys; silent when equal", () => {
    const minted = toBaseline(report(), pack({ meta: { "judge-prompt": "1.0.0" } }))
    expect(Option.isNone(versionDrift(pack({ meta: { "judge-prompt": "1.0.0" } }), minted))).toBe(true)
    const changed = versionDrift(pack({ meta: { "judge-prompt": "1.1.0" } }), minted)
    expect(Option.getOrThrow(changed)).toContain("judge-prompt 1.0.0")
    expect(Option.getOrThrow(changed)).toContain("judge-prompt 1.1.0")
    expect(Option.isSome(versionDrift(pack({ meta: {} }), minted))).toBe(true)
    // Old baselines without versions never drift against a meta-less pack.
    const bare = toBaseline(report(), pack())
    expect(Option.isNone(versionDrift(pack(), bare))).toBe(true)
  })
})
