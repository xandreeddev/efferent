import { describe, expect, it } from "bun:test"
import {
  ARCHITECT_AGENT,
  BUILTIN_TEAM_AGENTS,
  COORDINATOR_AGENT,
  IMPLEMENTER_AGENT,
} from "./teamAgents.js"

describe("the built-in coding team", () => {
  it("ships the three roles", () => {
    expect(BUILTIN_TEAM_AGENTS.map((a) => a.name)).toEqual([
      "coordinator",
      "architect",
      "implementer",
    ])
  })

  it("coordinator delegates (run_agent + comms) but does not write code", () => {
    const tools = COORDINATOR_AGENT.tools ?? []
    expect(tools).toContain("run_agent")
    expect(tools).toContain("blackboard_post")
    expect(tools).toContain("send_message")
    expect(tools).not.toContain("write_file")
    expect(tools).not.toContain("edit_file")
  })

  it("architect is a read-only validator (no write / edit / run_agent)", () => {
    const tools = ARCHITECT_AGENT.tools ?? []
    expect(tools).not.toContain("write_file")
    expect(tools).not.toContain("edit_file")
    expect(tools).not.toContain("run_agent")
    // It must say its verdict vocabulary so the coordinator can act on it.
    expect(ARCHITECT_AGENT.body).toContain("SOUND")
    expect(ARCHITECT_AGENT.body).toContain("NEEDS WORK")
    expect(ARCHITECT_AGENT.body).toContain("BLOCKED")
  })

  it("implementer is a leaf coder (undefined tools ⇒ all base, no run_agent)", () => {
    // `tools: undefined` → roleToolEntries returns the base coding tools only.
    expect(IMPLEMENTER_AGENT.tools).toBeUndefined()
  })
})
