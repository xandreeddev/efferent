import { describe, expect, it } from "bun:test"
import {
  ARCHITECT_AGENT,
  BACKEND_AGENT,
  BUILTIN_TEAM_AGENTS,
  COORDINATOR_AGENT,
  FRONTEND_AGENT,
  IMPLEMENTER_AGENT,
  PRODUCT_AGENT,
  QA_AGENT,
} from "./teamAgents.js"

describe("the built-in coding team", () => {
  it("ships the coordinator + the specialist roster", () => {
    expect(BUILTIN_TEAM_AGENTS.map((a) => a.name)).toEqual([
      "coordinator",
      "architect",
      "product",
      "frontend",
      "backend",
      "qa",
      "implementer",
    ])
  })

  it("coordinator leads (run_agent + wait_for_agents + comms) but does not write code", () => {
    const tools = COORDINATOR_AGENT.tools ?? []
    expect(tools).toContain("run_agent")
    expect(tools).toContain("wait_for_agents") // gathers without blocking
    expect(tools).toContain("blackboard_post")
    expect(tools).toContain("send_message")
    expect(tools).toContain("update_plan")
    expect(tools).not.toContain("write_file")
    expect(tools).not.toContain("edit_file")
  })

  it("architect is a read-only validator (no write / edit / run_agent / wait_for_agents)", () => {
    const tools = ARCHITECT_AGENT.tools ?? []
    expect(tools).not.toContain("write_file")
    expect(tools).not.toContain("edit_file")
    expect(tools).not.toContain("run_agent")
    expect(tools).not.toContain("wait_for_agents")
    // It must say its verdict vocabulary so the coordinator can act on it.
    expect(ARCHITECT_AGENT.body).toContain("SOUND")
    expect(ARCHITECT_AGENT.body).toContain("NEEDS WORK")
    expect(ARCHITECT_AGENT.body).toContain("BLOCKED")
  })

  it("implementing specialists are leaf coders: full coding toolkit + comms, but no run_agent/wait_for_agents", () => {
    for (const agent of [IMPLEMENTER_AGENT, FRONTEND_AGENT, BACKEND_AGENT, QA_AGENT, PRODUCT_AGENT]) {
      const tools = agent.tools ?? []
      expect(tools).toContain("read_file")
      expect(tools).toContain("edit_file")
      expect(tools).toContain("Bash")
      // They coordinate (post/read the board, message siblings)…
      expect(tools).toContain("blackboard_post")
      expect(tools).toContain("send_message")
      // …but they don't spawn or gather — they're leaves.
      expect(tools).not.toContain("run_agent")
      expect(tools).not.toContain("wait_for_agents")
    }
  })
})
