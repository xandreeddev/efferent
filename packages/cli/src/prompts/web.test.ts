import { describe, expect, test } from "bun:test"
import { webAgentPrompt, webAgentSystemPrompt } from "./web.js"
import { coderPrompt } from "./coder.js"

describe("webAgentPrompt", () => {
  const text = webAgentSystemPrompt("/w", new Date("2026-07-02T00:00:00Z"))

  test("its own identity: a GENERAL assistant, not a code tool — must not refuse non-software asks", () => {
    expect(text).toContain("efferent web")
    expect(text).toContain("interactive experiences with natural language")
    expect(text).toContain("GENERAL assistant, not a code tool")
    expect(text).toContain("carbonara recipe page")
    expect(text).toContain(`never tell the user a request is "out of scope"`)
    // The coder's software-scoped framing must NOT leak in.
    expect(text).not.toContain("almost anything in a software context")
    expect(text).not.toContain("You are a coding assistant")
  })

  test("render_ui leads the tools list and the canvas section carries the inversion", () => {
    expect(text).toContain("- render_ui({ id, title?, html, mode?, active? })")
    expect(text).toContain("# The web canvas — build pages, not walls of text")
    expect(text).toContain("NEVER write a Markdown or HTML file to disk")
    expect(text).toContain("[viewing:<page-id>]")
    expect(text).toContain(`<pre class="ef-mermaid">`)
    // The multi-column mandate — a flat stack is a failure.
    expect(text).toContain("NOT A FLAT LIST")
    expect(text).toContain("ef-split")
    // The canvas section sits ABOVE the task guidance (salience).
    expect(text.indexOf("# The web canvas")).toBeLessThan(text.indexOf("# Doing the task"))
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
