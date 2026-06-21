import { describe, expect, it } from "bun:test"
import type { AgentDefinition } from "@xandreed/sdk-core"
import { renderScopeSystemPrompt, rootSystemPrompt } from "./coder.js"

const role = (name: string): AgentDefinition => ({
  name,
  description: `the ${name}`,
  body: `you are the ${name}`,
  sourcePath: "<test>",
})

describe("rootSystemPrompt", () => {
  it("delegates coding to the coordinator when the role is present", () => {
    const p = rootSystemPrompt("/w", new Date(0), [], [], [role("coordinator")], [])
    expect(p).toContain("# Triage and dispatch")
    expect(p).toContain('run_agent({ agent: "coordinator"')
  })

  it("dispatches deep research to the research-coordinator when the role is present", () => {
    const p = rootSystemPrompt("/w", new Date(0), [], [], [role("research-coordinator")], [])
    expect(p).toContain("# Triage and dispatch")
    expect(p).toContain('run_agent({ agent: "research-coordinator"')
  })

  it("offers both branches when both leads are loaded", () => {
    const p = rootSystemPrompt(
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

  it("omits the dispatch section when no lead role is loaded", () => {
    const p = rootSystemPrompt("/w", new Date(0), [], [], [], [])
    expect(p).not.toContain("# Triage and dispatch")
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
})
