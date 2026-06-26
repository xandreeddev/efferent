import { test, expect } from "bun:test"
import { extractJsonArray } from "./tierC.js"

/**
 * The evals runner interleaves `[HH:MM:SS] INFO …` logs with the final JSON on
 * stdout — the extractor must find the real RunAgg array, not a timestamp.
 */
test("extractJsonArray finds the report array past a `[timestamp]` log preamble", () => {
  const stdout = `[19:48:56.584] INFO (#52): skills: skipping /tmp/.efferent/skills
  eval.case: search-for-symbol
[19:48:59.172] INFO (#52): done
[
  {
    "configName": "default",
    "suites": [ { "suite": "tool-selection", "mean": 1, "passRate": 1 } ]
  }
]`
  const parsed = extractJsonArray(stdout) as Array<{ suites: Array<{ suite: string; passRate: number }> }>
  expect(Array.isArray(parsed)).toBe(true)
  expect(parsed[0]!.suites[0]!.suite).toBe("tool-selection")
  expect(parsed[0]!.suites[0]!.passRate).toBe(1)
})

test("extractJsonArray returns undefined when there is no array", () => {
  expect(extractJsonArray("[12:00:00] INFO only logs, no report")).toBeUndefined()
})
