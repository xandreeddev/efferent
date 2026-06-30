import { describe, expect, it } from "bun:test"
import type { AgentDefinition, Memory } from "@xandreed/sdk-core"
import { renderScopeSystemPrompt } from "@xandreed/sdk-core"
import { coderSystemPrompt } from "./coder.js"

const role = (name: string): AgentDefinition => ({
  name,
  description: `the ${name}`,
  body: `you are the ${name}`,
  sourcePath: "<test>",
})

const mem = (name: string, title: string, summary = ""): Memory => ({
  name,
  title,
  summary,
  sourcePath: `/w/.efferent/memory/${name}.md`,
})

describe("coderSystemPrompt orchestration policy", () => {
  it("routes code work through the coordinator and forbids the root coding itself", () => {
    const p = coderSystemPrompt("/w", new Date(0), [], [], [role("coordinator")], [])
    expect(p).toContain("# Your role: orchestrate")
    expect(p).toContain('run_agent({ agent: "coordinator"')
    expect(p).toContain("any size")
    // The old "do it yourself by default" stance + the standalone `# Writing code`
    // section are gone — orchestration is unconditional now.
    expect(p).not.toContain("Do the work yourself by default")
    expect(p).not.toContain("# Writing code")
  })

  it("the orchestrate prompt is HONEST about its tools — only the four it has, no work tools", () => {
    // The regression this guards: a stripped (no-work-tools) toolkit under a prompt
    // that still advertised read_file/grep/edit_file and told the root to "read the
    // workspace" / "Read the blackboard FIRST". A weak model couldn't reconcile that
    // and looped on the housekeeping tools instead of delegating.
    const p = coderSystemPrompt("/w", new Date(0), [], [], [role("coordinator")], [])
    expect(p).toContain("You have NO work tools")
    for (const t of ["run_agent(", "wait_for_agents(", "send_message(", "update_plan("]) {
      expect(p).toContain(t)
    }
    for (const gone of [
      "read_file",
      "edit_file",
      "write_file",
      "grep(",
      "glob(",
      "Bash(",
      "search_web",
      "web_fetch",
      "blackboard",
      "Read the blackboard FIRST",
      "list_scheduled_jobs",
      "schedule(",
      "Use tools to read the workspace",
    ]) {
      expect(p).not.toContain(gone)
    }
  })

  it("routes investigation through the research-coordinator (no standalone research section)", () => {
    const p = coderSystemPrompt("/w", new Date(0), [], [], [role("research-coordinator")], [])
    expect(p).toContain("# Your role: orchestrate")
    expect(p).toContain('run_agent({ agent: "research-coordinator"')
    expect(p).not.toContain("# Investigating & researching")
  })

  it("direct mode (no lead loaded) keeps the full work toolkit", () => {
    // The non-orchestrate path is unchanged: a no-fleet roster gets the hands-on
    // coder with real work tools and no orchestrate block.
    const p = coderSystemPrompt("/w", new Date(0), [], [], [], [])
    expect(p).toContain("read_file(")
    expect(p).toContain("edit_file(")
    expect(p).not.toContain("# Your role: orchestrate")
    expect(p).not.toContain("You have NO work tools")
  })

  it("names both leads when both are loaded", () => {
    const p = coderSystemPrompt(
      "/w",
      new Date(0),
      [],
      [],
      [role("coordinator"), role("research-coordinator")],
      [],
    )
    expect(p).toContain('run_agent({ agent: "coordinator"')
    expect(p).toContain('run_agent({ agent: "research-coordinator"')
  })

  it("stays direct only for pure interaction", () => {
    const p = coderSystemPrompt("/w", new Date(0), [], [], [role("coordinator")], [])
    expect(p).toContain("pure interaction")
  })

  it("instructs fan-out discipline: decompose once, gather by looping, never re-spawn on an early wait", () => {
    const p = coderSystemPrompt("/w", new Date(0), [], [], [role("coordinator")], [])
    expect(p).toContain("decompose ONCE")
    expect(p).toContain("NEVER re-spawn")
    // an early wait return is normal — keep looping, don't escalate
    expect(p).toContain("allDone: false")
    expect(p).toContain("Loop wait_for_agents until")
  })

  it("omits the policy when no lead role is loaded", () => {
    const p = coderSystemPrompt("/w", new Date(0), [], [], [], [])
    expect(p).not.toContain("# Your role: orchestrate")
  })

  it("always orchestrates regardless of a distinct code model", () => {
    const withCode = coderSystemPrompt("/w", new Date(0), [], [], [role("coordinator")], [], [], true)
    expect(withCode).toContain("# Your role: orchestrate")
    expect(withCode).not.toContain("# Writing code")
    const noCode = coderSystemPrompt("/w", new Date(0), [], [], [role("coordinator")], [])
    expect(noCode).toContain("# Your role: orchestrate")
  })
})

describe("renderScopeSystemPrompt", () => {
  // A lead (coordinator) holds run_agent + wait_for_agents + comms.
  const LEAD_TOOLS = [
    "read_file",
    "grep",
    "glob",
    "ls",
    "Bash",
    "update_plan",
    "run_agent",
    "wait_for_agents",
    "send_message",
    "blackboard_post",
    "blackboard_read",
  ]
  // A leaf coder: coding + comms, no spawn/wait.
  const LEAF_TOOLS = [
    "read_file",
    "write_file",
    "edit_file",
    "Bash",
    "grep",
    "glob",
    "ls",
    "update_plan",
    "send_message",
    "blackboard_post",
    "blackboard_read",
  ]
  // A read-only reviewer (architect): no write, no spawn, no comms.
  const READONLY_TOOLS = ["read_file", "grep", "glob", "ls", "Bash"]

  it("includes the agent roster so a coordinator (a role that can spawn) can name its specialists", () => {
    const p = renderScopeSystemPrompt({
      name: "coordinator",
      rootDir: "/w/pkg",
      displayRoot: "/w",
      body: "drive the team",
      now: new Date(0),
      toolNames: LEAD_TOOLS,
      agents: [role("implementer"), role("architect")],
    })
    expect(p).toContain("# Agent roles")
    expect(p).toContain("implementer")
    expect(p).toContain("# Sub-agents")
  })

  it("omits the roster + sub-agents doctrine for a leaf worker that can't spawn", () => {
    const p = renderScopeSystemPrompt({
      name: "implementer",
      rootDir: "/w/pkg",
      displayRoot: "/w",
      body: "do the piece",
      now: new Date(0),
      toolNames: LEAF_TOOLS,
      // Even if a roster is passed, a non-spawner doesn't get it.
      agents: [role("architect")],
    })
    expect(p).not.toContain("# Agent roles")
    expect(p).not.toContain("# Sub-agents")
  })

  it("a read-only role's prompt advertises ONLY its tools and no fleet doctrine (drift guard)", () => {
    const p = renderScopeSystemPrompt({
      name: "architect",
      rootDir: "/w/pkg",
      displayRoot: "/w",
      body: "review it",
      now: new Date(0),
      toolNames: READONLY_TOOLS,
      agents: [role("implementer")],
    })
    expect(p).toContain("- read_file(")
    expect(p).toContain("- grep(")
    // the old static block lied — these must NOT appear for a read-only reviewer:
    expect(p).not.toContain("- write_file(")
    expect(p).not.toContain("- edit_file(")
    expect(p).not.toContain("- run_agent(")
    expect(p).not.toContain("- wait_for_agents(")
    expect(p).not.toContain("- blackboard_post(")
    expect(p).not.toContain("# Sub-agents")
    expect(p).not.toContain("# Agent roles")
    expect(p).not.toContain("Read the blackboard FIRST")
  })

  it("a comms-capable leaf gets the blackboard guidance but not the wait_for_agents loop", () => {
    const p = renderScopeSystemPrompt({
      name: "implementer",
      rootDir: "/w/pkg",
      displayRoot: "/w",
      body: "do the piece",
      now: new Date(0),
      toolNames: LEAF_TOOLS,
    })
    expect(p).toContain("Read the blackboard FIRST")
    expect(p).toContain("- send_message(")
    expect(p).not.toContain("- wait_for_agents(")
  })

  it("injects the project-knowledge index when memory is present", () => {
    const p = renderScopeSystemPrompt({
      name: "implementer",
      rootDir: "/w/pkg",
      displayRoot: "/w",
      body: "do the piece",
      now: new Date(0),
      toolNames: LEAF_TOOLS,
      memory: [mem("router-policy", "Per-request provider routing", "why we resolve keys per turn")],
    })
    expect(p).toContain("# Project knowledge")
    expect(p).toContain("- router-policy: Per-request provider routing — why we resolve keys per turn")
    expect(p).toContain("read_memory({ name })")
    expect(p).toContain("remember(")
  })

  it("omits the project-knowledge section when there is no memory", () => {
    const p = renderScopeSystemPrompt({
      name: "implementer",
      rootDir: "/w/pkg",
      displayRoot: "/w",
      body: "do the piece",
      now: new Date(0),
      toolNames: LEAF_TOOLS,
    })
    expect(p).not.toContain("# Project knowledge")
  })
})

describe("memory in the coder prompt", () => {
  it("lists each record's name + title + summary and points at read_memory/remember", () => {
    const p = coderSystemPrompt("/w", new Date(0), [], [], [], [], [
      mem("adr-effect-services", "Services as Context.Tag + Layer", "ports & adapters from day 1"),
      mem("gotcha-gemini-tools", "Gemini needs a param on every tool"),
    ])
    expect(p).toContain("# Project knowledge")
    expect(p).toContain(
      "- adr-effect-services: Services as Context.Tag + Layer — ports & adapters from day 1",
    )
    // No summary ⇒ no trailing em-dash clause.
    expect(p).toContain("- gotcha-gemini-tools: Gemini needs a param on every tool")
    expect(p).not.toContain("Gemini needs a param on every tool — ")
    expect(p).toContain("read_memory({ name })")
    expect(p).toContain("remember({ title, content })")
  })

  it("still offers `remember` but no index/read_memory when there is no memory", () => {
    const p = coderSystemPrompt("/w", new Date(0), [], [], [], [], [])
    expect(p).not.toContain("# Project knowledge")
    expect(p).not.toContain("read_memory({ name })")
    // `remember` is always available — recording knowledge needs no prior records.
    expect(p).toContain("remember({ title, content })")
  })
})
