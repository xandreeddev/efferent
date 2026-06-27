import { describe, expect, it } from "bun:test"
import { renderInstructionsSection } from "./discoverInstructionFiles.js"

describe("renderInstructionsSection — operating-guidance overlay (Phase 2)", () => {
  it("renders an `operating` file under # Operating guidance, ABOVE # Constraints", () => {
    const out = renderInstructionsSection([
      { path: "/p/.efferent/CONSTRAINTS.md", content: "- [no-try] no try/catch in the domain", kind: "constraints" },
      { path: "/p/.efferent/prompts/coder.md", content: "- [plan-first] plan before multi-step work", kind: "operating" },
      { path: "/p/AGENT.md", content: "Project guidance.", kind: "agent" },
    ])
    expect(out).toContain("# Operating guidance")
    expect(out).toContain("plan before multi-step work")
    expect(out).toContain("# Constraints")
    expect(out).toContain("# Instructions")
    // Operating guidance shapes HOW you work → it renders first.
    expect(out.indexOf("# Operating guidance")).toBeLessThan(out.indexOf("# Constraints"))
    expect(out.indexOf("# Constraints")).toBeLessThan(out.indexOf("# Instructions"))
  })

  it("no operating file → no # Operating guidance heading", () => {
    const out = renderInstructionsSection([
      { path: "/p/.efferent/CONSTRAINTS.md", content: "- [x] rule", kind: "constraints" },
    ])
    expect(out).not.toContain("# Operating guidance")
    expect(out).toContain("# Constraints")
  })
})
