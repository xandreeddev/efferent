import { describe, expect, it } from "bun:test"
import {
  BUILTIN_RESEARCH_AGENTS,
  RESEARCH_COORDINATOR_AGENT,
  RESEARCHER_AGENT,
} from "./researchAgents.js"

describe("the built-in research team", () => {
  it("ships the research-coordinator + the researcher leaf", () => {
    expect(BUILTIN_RESEARCH_AGENTS.map((a) => a.name)).toEqual([
      "research-coordinator",
      "researcher",
    ])
  })

  it("research-coordinator DELEGATES — run_agent + wait_for_agents + comms, but never searches or writes", () => {
    const tools = RESEARCH_COORDINATOR_AGENT.tools ?? []
    expect(tools).toContain("run_agent")
    expect(tools).toContain("wait_for_agents") // gathers without blocking
    expect(tools).toContain("blackboard_post")
    expect(tools).toContain("send_message")
    expect(tools).toContain("update_plan")
    // It can read the workspace to ground the angles…
    expect(tools).toContain("read_file")
    // …but it does NOT search the web itself — searching is the researchers'
    // job. Giving the coordinator search_web let it loop plan→search→search
    // instead of delegating, which never converged (stuck research fleet).
    expect(tools).not.toContain("search_web")
    expect(tools).not.toContain("web_fetch")
    expect(tools).not.toContain("write_file")
    expect(tools).not.toContain("edit_file")
  })

  it("researcher is a web-only leaf: search/fetch + read + comms, no write/spawn/gather", () => {
    const tools = RESEARCHER_AGENT.tools ?? []
    expect(tools).toContain("search_web")
    expect(tools).toContain("web_fetch")
    expect(tools).toContain("read_file")
    // It coordinates over the bus…
    expect(tools).toContain("blackboard_post")
    expect(tools).toContain("send_message")
    // …but it's a leaf — no writing, no spawning, no gathering.
    expect(tools).not.toContain("write_file")
    expect(tools).not.toContain("edit_file")
    expect(tools).not.toContain("run_agent")
    expect(tools).not.toContain("wait_for_agents")
  })
})
