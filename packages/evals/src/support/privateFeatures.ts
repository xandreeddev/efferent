import { readFileSync } from "node:fs"
import type { FeatureScenario } from "../dataset/feature.js"

/**
 * Held-out PRIVATE scenarios — load extra `FeatureScenario`s from a JSON file
 * pointed to by `EFFERENT_EVAL_PRIVATE`, so a team can keep their hardest /
 * most-revealing cases OUT of the public repo (the contamination/overfitting
 * lesson from SWE-bench/LiveCodeBench: a frozen public suite gets gamed). The
 * file is a JSON array of `FeatureScenario` (all fields are JSON-serialisable —
 * stubs/tests/reference are string maps). Fail-soft: a missing/!set/!parseable
 * file yields no extra scenarios (the public set still runs).
 *
 * Validate private scenarios with the same determinism pre-check before trusting
 * their scores (run `validateScenario` over them in your own harness).
 */
export const loadPrivateFeatures = (): ReadonlyArray<FeatureScenario> => {
  const path = process.env["EFFERENT_EVAL_PRIVATE"]
  if (path === undefined || path.trim().length === 0) return []
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ReadonlyArray<FeatureScenario>
    return Array.isArray(parsed) ? parsed : []
  } catch {
    console.warn(`⚠ EFFERENT_EVAL_PRIVATE set but ${path} is unreadable/invalid — skipping private scenarios`)
    return []
  }
}
