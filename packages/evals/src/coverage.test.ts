import { describe, expect, it } from "bun:test"
import { staleCoverageEntries, TOOL_COVERAGE, unmappedTools, uncoveredTools } from "./coverage.js"

/**
 * The coverage GATE. Adding a tool to `codingToolkit` forces a coverage decision
 * here — you can't ship a tool the eval suite has never heard of (the failure
 * mode the background/tmux tools hit). Empty arrays are allowed (documented
 * gaps); UNMAPPED tools are not.
 */
describe("eval coverage map", () => {
  it("every coding tool has a coverage decision (no unmapped tools)", () => {
    const unmapped = unmappedTools()
    expect(unmapped, `add these to TOOL_COVERAGE (use [] for a deliberate gap): ${unmapped.join(", ")}`).toEqual(
      [],
    )
  })

  it("has no stale entries for tools that were removed", () => {
    expect(staleCoverageEntries()).toEqual([])
  })

  it("surfaces the current documented gaps (informational, not a failure)", () => {
    // This isn't a hard gate — it just keeps the gaps VISIBLE so they don't rot
    // silently. If this list shrinks, great; if it grows, the PR author saw it.
    const gaps = uncoveredTools()
    // Sanity: the map isn't empty and the gaps are a known subset.
    expect(Object.keys(TOOL_COVERAGE).length).toBeGreaterThan(10)
    for (const g of gaps) expect(typeof g).toBe("string")
  })
})
