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

describe("coderSystemPrompt delegation policy", () => {
  it("offers a coding fleet when the coordinator is present — but defaults to doing the work itself", () => {
    const p = coderSystemPrompt("/w", new Date(0), [], [], [role("coordinator")], [])
    expect(p).toContain("# When to delegate")
    expect(p).toContain('run_agent({ agent: "coordinator"')
    expect(p).toContain("Do the work yourself by default")
    // The forced-delegation "thin router" mandate is gone.
    expect(p).not.toContain("thin router")
    expect(p).not.toContain("When in doubt, DISPATCH")
  })

  it("offers a research fleet when the research-coordinator is present", () => {
    const p = coderSystemPrompt("/w", new Date(0), [], [], [role("research-coordinator")], [])
    expect(p).toContain("# When to delegate")
    expect(p).toContain('run_agent({ agent: "research-coordinator"')
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

  it("omits the delegation policy when no lead role is loaded", () => {
    const p = coderSystemPrompt("/w", new Date(0), [], [], [], [])
    expect(p).not.toContain("# When to delegate")
  })
})

describe("coderSystemPrompt code-delegation policy", () => {
  it("routes code-writing to the code tier when a distinct code model is configured", () => {
    // 8th positional arg = codeModelConfigured.
    const p = coderSystemPrompt("/w", new Date(0), [], [], [role("coordinator")], [], [], true)
    expect(p).toContain("# Writing code")
    expect(p).toContain('run_agent({ folder, task, role: "code" })')
    // The fleet "do it yourself" default is reframed to defer code-writing.
    expect(p).toContain("Do the investigating, planning, running, and reviewing yourself")
    expect(p).not.toContain("Do the work yourself by default")
  })

  it("omits the code-delegation policy when no distinct code model is configured", () => {
    const p = coderSystemPrompt("/w", new Date(0), [], [], [role("coordinator")], [])
    expect(p).not.toContain("# Writing code")
    // …and the original all-yourself fast path stands.
    expect(p).toContain("Do the work yourself by default")
  })

  it("the code-delegation policy is independent of the fleet roster", () => {
    // No coordinator ⇒ no `# When to delegate`, but `# Writing code` still shows
    // (a distinct code model routes writing to the code tier regardless).
    const p = coderSystemPrompt("/w", new Date(0), [], [], [], [], [], true)
    expect(p).not.toContain("# When to delegate")
    expect(p).toContain("# Writing code")
  })
})

describe("renderScopeSystemPrompt", () => {
  it("includes the agent roster so a coordinator can name its specialists", () => {
    const p = renderScopeSystemPrompt({
      name: "coordinator",
      rootDir: "/w/pkg",
      displayRoot: "/w",
      body: "drive the team",
      now: new Date(0),
      agents: [role("implementer"), role("architect")],
    })
    expect(p).toContain("# Agent roles")
    expect(p).toContain("implementer")
    expect(p).toContain("architect")
  })

  it("omits the roster for a leaf worker (no agents)", () => {
    const p = renderScopeSystemPrompt({
      name: "implementer",
      rootDir: "/w/pkg",
      displayRoot: "/w",
      body: "do the piece",
      now: new Date(0),
    })
    expect(p).not.toContain("# Agent roles")
  })

  it("injects the project-knowledge index when memory is present", () => {
    const p = renderScopeSystemPrompt({
      name: "implementer",
      rootDir: "/w/pkg",
      displayRoot: "/w",
      body: "do the piece",
      now: new Date(0),
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
    })
    expect(p).not.toContain("# Project knowledge")
    expect(p).not.toContain("read_memory({ name })")
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
