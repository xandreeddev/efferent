import { describe, expect, it } from "bun:test"
import {
  parseDirective,
  renderDirectiveSection,
  VERIFIER_AGENT,
  withBuiltinAgents,
} from "./directive.js"

describe("parseDirective", () => {
  it("parses a bare objective", () => {
    expect(parseDirective("get tests green")).toEqual({ objective: "get tests green" })
  })
  it("splits objective :: criteria", () => {
    expect(parseDirective("ship feature X :: all suites pass and typecheck clean")).toEqual({
      objective: "ship feature X",
      criteria: "all suites pass and typecheck clean",
    })
  })
  it("returns undefined for empty / criteria-only input", () => {
    expect(parseDirective("   ")).toBeUndefined()
    expect(parseDirective(":: only criteria")).toBeUndefined()
  })
})

describe("renderDirectiveSection", () => {
  it("is empty when no directive", () => {
    expect(renderDirectiveSection(undefined)).toBe("")
  })
  it("renders objective + criteria + the verify nudge", () => {
    const s = renderDirectiveSection({ objective: "do X", criteria: "Y holds" })
    expect(s).toContain("# Directive (standing goal)")
    expect(s).toContain("do X")
    expect(s).toContain("Done when: Y holds")
    expect(s).toContain(":verify")
  })
})

describe("withBuiltinAgents", () => {
  it("adds the built-in verifier when absent", () => {
    const merged = withBuiltinAgents([])
    expect(merged.map((a) => a.name)).toContain("verifier")
    expect(VERIFIER_AGENT.tools).not.toContain("write_file")
    expect(VERIFIER_AGENT.tools).not.toContain("edit_file")
  })
  it("lets a workspace file role of the same name win", () => {
    const custom = { name: "verifier", description: "mine", body: "custom", sourcePath: "/x.md" }
    const merged = withBuiltinAgents([custom])
    expect(merged.filter((a) => a.name === "verifier")).toEqual([custom])
  })
})
