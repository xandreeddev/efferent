import { expect, test } from "bun:test"
import { FEATURES } from "../dataset/feature.js"
import { validateScenario } from "./validateSuites.js"

/** The hidden tests must never be in the agent's STARTING workspace (`files`) —
 *  they're injected only after the run. Guards against a scenario accidentally
 *  shipping its own oracle where the agent could read or overfit to it. */
test("hidden tests are never present in the agent's starting workspace", () => {
  for (const s of FEATURES) {
    const stubPaths = Object.keys(s.files)
    for (const hidden of Object.keys(s.hiddenTests)) {
      expect(stubPaths).not.toContain(hidden)
      for (const stub of Object.values(s.files)) expect(stub.includes(hidden)).toBe(false)
    }
  }
})

/**
 * Guards the hidden test suites: each scenario's known-good reference impl must
 * pass its hidden tests deterministically across N runs. A new/edited hidden
 * test that's flaky (or that a correct impl can't pass) fails CI here — before
 * it ever corrupts a model's eval score. No LLM, no Docker, no provider key.
 */
for (const s of FEATURES) {
  test(
    `hidden suite is a reliable oracle: ${s.name}`,
    () => {
      const check = validateScenario(s, 3)
      // Surface the detail on failure (flaky runs / reference can't pass).
      expect(check.detail).toBeString()
      expect(check.deterministic).toBe(true)
      expect(check.allPass).toBe(true)
    },
    120_000,
  )
}
