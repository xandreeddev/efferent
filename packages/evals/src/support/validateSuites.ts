import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { FeatureScenario } from "../dataset/feature.js"

/**
 * Determinism pre-check for the hidden test suites — the #1 reliability threat in
 * execution-graded evals (SWE-bench: 30/34 flaky tasks flaked on the *gold*
 * solution; only ~39% of instances were verifiably deterministic). A pass-ratio
 * is only trustworthy if the oracle is. This runs each scenario's KNOWN-GOOD
 * `reference` impl against its hidden tests N times and asserts every run is
 * identical AND green — so a flaky or broken hidden test is caught before it can
 * silently corrupt a model's score.
 *
 * Runs on the host (no Docker): the feature scenarios are pure, dependency-free
 * TS with INJECTED clocks (no real time/network/randomness), so host execution
 * is byte-identical to the container — and this stays runnable in CI via
 * `bun test` without a Docker daemon.
 */

const countMatch = (s: string, re: RegExp): number => {
  const m = s.match(re)
  return m !== null && m[1] !== undefined ? Number(m[1]) : 0
}

interface RunCount {
  readonly pass: number
  readonly fail: number
  readonly exitCode: number
}

const runOnce = (dir: string, testPaths: ReadonlyArray<string>): RunCount => {
  const r = spawnSync("bun", ["test", ...testPaths], { cwd: dir, encoding: "utf8", timeout: 60_000 })
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`
  return { pass: countMatch(out, /(\d+)\s+pass/), fail: countMatch(out, /(\d+)\s+fail/), exitCode: r.status ?? 1 }
}

export interface SuiteCheck {
  readonly name: string
  readonly runs: ReadonlyArray<RunCount>
  /** Every run produced identical pass/fail/exit — the oracle is stable. */
  readonly deterministic: boolean
  /** Every run was green (exit 0, ≥1 pass, 0 fail) — the reference actually passes. */
  readonly allPass: boolean
  /** deterministic AND allPass — the suite is a reliable oracle. */
  readonly ok: boolean
  readonly detail: string
}

/** Run one scenario's reference impl against its hidden tests `samples` times. */
export const validateScenario = (s: FeatureScenario, samples = 3): SuiteCheck => {
  if (s.reference === undefined) {
    return { name: s.name, runs: [], deterministic: false, allPass: false, ok: false, detail: "no reference impl to validate against" }
  }
  const dir = mkdtempSync(join(tmpdir(), "eval-validate-"))
  try {
    for (const [rel, content] of Object.entries(s.reference)) {
      const abs = join(dir, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content)
    }
    for (const [rel, content] of Object.entries(s.hiddenTests)) {
      const abs = join(dir, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content)
    }
    const paths = s.testPaths ?? Object.keys(s.hiddenTests)
    const runs = Array.from({ length: Math.max(1, samples) }, () => runOnce(dir, paths))
    const first = runs[0]!
    const deterministic = runs.every((r) => r.pass === first.pass && r.fail === first.fail && r.exitCode === first.exitCode)
    const allPass = runs.every((r) => r.exitCode === 0 && r.fail === 0 && r.pass > 0)
    const detail = deterministic
      ? allPass
        ? `${first.pass} pass × ${runs.length} runs, stable`
        : `reference does NOT pass: ${first.pass} pass / ${first.fail} fail (exit ${first.exitCode})`
      : `FLAKY: runs disagreed — ${runs.map((r) => `${r.pass}p/${r.fail}f`).join(", ")}`
    return { name: s.name, runs, deterministic, allPass, ok: deterministic && allPass, detail }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export const validateSuites = (
  scenarios: ReadonlyArray<FeatureScenario>,
  samples = 3,
): ReadonlyArray<SuiteCheck> => scenarios.map((s) => validateScenario(s, samples))
