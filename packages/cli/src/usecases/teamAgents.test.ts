import { describe, expect, it } from "bun:test"
import {
  ARCHITECT_AGENT,
  BACKEND_AGENT,
  BUILTIN_TEAM_AGENTS,
  coordinatorAgent,
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

  it("the gate is STRUCTURAL: the coordinator never carries verify_with_gate/note_constraint (any setting)", () => {
    // The Opus gate + learn + retry run in the runtime when the coordinator
    // returns — not via tools the model drives. So those tools are gone at every
    // setting; autoLoop only shapes whether the prompt tells it to EXPECT the gate.
    for (const autoLoop of [true, false]) {
      const c = coordinatorAgent({ autoLoop, maxLoopAttempts: 4 })
      expect(c.tools).not.toContain("verify_with_gate")
      expect(c.tools).not.toContain("note_constraint")
      expect(c.body).not.toContain("verify_with_gate")
      // still a lead (spawns + gathers), still doesn't write code itself
      expect(c.tools).toContain("run_agent")
      expect(c.tools).toContain("wait_for_agents")
      expect(c.tools).not.toContain("edit_file")
    }
  })

  it("autoLoop ON → DELIVER is gate-aware (deliver honestly, expect the automatic re-gate)", () => {
    const c = coordinatorAgent({ autoLoop: true, maxLoopAttempts: 4 })
    expect(c.body).toContain("DELIVER")
    expect(c.body).toContain("INDEPENDENT Opus gate")
    expect(c.body).toContain("automatically")
    expect(COORDINATOR_AGENT.body).toContain("INDEPENDENT Opus gate") // default export
  })

  it("autoLoop OFF → plain architect-only deliver, no gate mention", () => {
    const c = coordinatorAgent({ autoLoop: false, maxLoopAttempts: 3 })
    expect(c.body).toContain("DELIVER")
    expect(c.body).not.toContain("Opus gate")
  })

  it("implementing specialists are leaf coders: full coding toolkit + comms, but no run_agent/wait_for_agents", () => {
    for (const agent of [IMPLEMENTER_AGENT, FRONTEND_AGENT, BACKEND_AGENT, QA_AGENT]) {
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

  it("product is READ-ONLY: it clarifies requirements, it does not write code", () => {
    const tools = PRODUCT_AGENT.tools ?? []
    expect(tools).toContain("read_file")
    expect(tools).toContain("grep")
    // coordinates its spec decisions…
    expect(tools).toContain("blackboard_post")
    expect(tools).toContain("send_message")
    // …but cannot mint code (its body says "not to write feature code").
    expect(tools).not.toContain("write_file")
    expect(tools).not.toContain("edit_file")
    expect(tools).not.toContain("Bash")
    expect(tools).not.toContain("run_agent")
  })
})
