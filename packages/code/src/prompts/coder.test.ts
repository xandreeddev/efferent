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
    expect(p).toContain("# Delegating coding work")
    expect(p).toContain('run_agent({ agent: "coordinator"')
  })

  it("omits the delegation section when no coordinator is loaded", () => {
    const p = rootSystemPrompt("/w", new Date(0), [], [], [], [])
    expect(p).not.toContain("# Delegating coding work")
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
