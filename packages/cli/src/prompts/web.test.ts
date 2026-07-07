import { describe, expect, test } from "bun:test"
import { webAgentPrompt, webAgentSystemPrompt } from "./web.js"
import { coderPrompt } from "./coder.js"

describe("webAgentPrompt", () => {
  const text = webAgentSystemPrompt("/w", new Date("2026-07-02T00:00:00Z"))

  test("its own identity: a GENERAL assistant, NOT a coding agent, with no filesystem", () => {
    expect(text).toContain("efferent web")
    expect(text).toContain("interactive experiences with natural language")
    expect(text).toContain("GENERAL assistant, NOT a coding agent")
    expect(text).toContain("carbonara recipe page")
    expect(text).toContain("no filesystem")
    expect(text).toContain("never go looking at local files")
    // The coder's software-scoped framing must NOT leak in.
    expect(text).not.toContain("almost anything in a software context")
    expect(text).not.toContain("You are a coding assistant")
  })

  test("has ONLY the content tools — render/research/plan, no code or workspace tools", () => {
    expect(text).toContain("- render_ui({ id, region?, title?, html, mode?, active? })")
    expect(text).toContain("- search_web({ query })")
    expect(text).toContain("- web_fetch({ url, maxBytes? })")
    expect(text).toContain("- update_plan(")
    // No filesystem/code/fleet tools are offered.
    for (const t of ["read_file(", "write_file(", "edit_file(", "Bash(", "grep(", "glob(", "ls(", "run_agent("]) {
      expect(text).not.toContain(t)
    }
    // No workspace/cwd framing that biases the model toward exploring the folder.
    expect(text).not.toContain("# Workspace")
    expect(text).not.toContain("cwd:")
  })

  test("the canvas section is design-forward Tailwind + carries the inversion", () => {
    expect(text).toContain("# The web canvas — you are a world-class web designer")
    expect(text).toContain("TAILWIND CSS")
    expect(text).toContain("v0")
    expect(text).toContain("NEVER write a Markdown/HTML file to disk")
    expect(text).toContain("[viewing:<page-id>]")
    expect(text).toContain(`<pre class="mermaid">`)
    // Multi-column mandate expressed in Tailwind terms.
    expect(text).toContain("grid grid-cols")
    // The canvas section sits ABOVE the task guidance (salience).
    expect(text.indexOf("# The web canvas")).toBeLessThan(text.indexOf("# Doing the task"))
  })

  test("teaches component streaming: build from regions, edit one, reuse the exact name", () => {
    expect(text).toContain("COMPONENTS (regions)")
    expect(text).toContain("region:'hero'")
    // The precise-edit discipline (the weak-model guardrail).
    expect(text).toContain("Reuse the EXACT region name to edit")
    expect(text).toContain("ONLY that component changes")
    // mode:'remove' is documented.
    expect(text).toContain("mode:'remove'")
  })

  test("versioned prompt named 'web'", () => {
    const p = webAgentPrompt("/w")
    expect(p.name).toBe("web")
    expect(p.version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  test("the coder prompt is untouched by the web split (no render_ui leak)", () => {
    const coder = coderPrompt("/w", new Date("2026-07-02T00:00:00Z"))
    expect(coder.text).not.toContain("render_ui")
    expect(coder.text).not.toContain("# The web canvas")
    expect(coder.text).toContain("- read_file({ path, offset?, limit? })")
  })
})
