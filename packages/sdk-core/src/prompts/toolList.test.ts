import { describe, expect, it } from "bun:test"
import { codingToolkit } from "../usecases/codingToolkit.js"
import { GENERIC_AGENT_TOOL_NAMES, hasBlurb, renderToolsFor } from "./toolList.js"

// The comms / orchestration tools a sub-agent's role allowlist can grant on top
// of the base coding toolkit (see `commsToolEntries` + `RunAgentTool` in
// buildScopeRuntime). Kept here as the canonical "everything grantable" set so a
// new grantable tool without a prompt blurb fails CI.
const ORCHESTRATION_TOOL_NAMES = [
  "run_agent",
  "wait_for_agents",
  "send_message",
  "blackboard_post",
  "blackboard_read",
  "run_tool",
  "schedule",
  "list_scheduled_jobs",
  "cancel_scheduled_job",
] as const

describe("renderToolsFor — the single-source tool list", () => {
  it("every tool the runtime can grant a sub-agent has a prompt blurb (drift guard)", () => {
    const grantable = [...Object.keys(codingToolkit.tools), ...ORCHESTRATION_TOOL_NAMES]
    const missing = grantable.filter((n) => !hasBlurb(n))
    expect(missing).toEqual([])
  })

  it("GENERIC_AGENT_TOOL_NAMES stays in sync with the real generic toolkit (set)", () => {
    const expected = new Set([...Object.keys(codingToolkit.tools), ...ORCHESTRATION_TOOL_NAMES])
    expect(new Set(GENERIC_AGENT_TOOL_NAMES)).toEqual(expected)
    // and every one of them renders
    expect(GENERIC_AGENT_TOOL_NAMES.every((n) => hasBlurb(n))).toBe(true)
  })

  it("renders exactly the tools given, in order, one line each", () => {
    const out = renderToolsFor(["read_file", "grep", "ls"])
    expect(out).toContain("# Tools")
    expect(out).toContain("- read_file(")
    expect(out).toContain("- grep(")
    expect(out).toContain("- ls(")
    // order preserved (anchor on "- <name>(" to avoid substring collisions)
    expect(out.indexOf("- read_file(")).toBeLessThan(out.indexOf("- grep("))
    expect(out.indexOf("- grep(")).toBeLessThan(out.indexOf("- ls("))
  })

  it("NEVER advertises a tool the role lacks — a read-only role gets no write/spawn lines", () => {
    // The architect's real toolkit: READONLY_TOOLS.
    const out = renderToolsFor(["read_file", "grep", "glob", "ls", "Bash"])
    expect(out).not.toContain("write_file")
    expect(out).not.toContain("edit_file")
    expect(out).not.toContain("run_agent")
    expect(out).not.toContain("wait_for_agents")
    expect(out).not.toContain("blackboard")
  })

  it("drops an unknown name rather than inventing a line, and empties to ''", () => {
    expect(renderToolsFor(["read_file", "not_a_real_tool"])).not.toContain("not_a_real_tool")
    expect(renderToolsFor([])).toBe("")
    expect(renderToolsFor(["nope"])).toBe("")
  })
})
