import { describe, expect, test } from "bun:test"
import { architectureReference, applicationReference, landingReference } from "@xandreed/ui-agent"
import { compileDesignTokenCss } from "./designTokens.js"
import { renderUiPage } from "./uiCompiler.js"
import { Either } from "effect"

const context = {
  pageId: "reference",
  csrfToken: "token",
  assets: new Map(),
  capabilities: new Set(["canvas.acknowledge", "canvas.request-demo"]),
}

describe("the trusted structured UI compiler", () => {
  test("renders complete landing, application, and architecture layouts without model-authored markup", () => {
    const rendered = [landingReference, applicationReference, architectureReference].map((reference) =>
      renderUiPage({ manifest: reference.page, blocks: reference.blocks, complete: true }, context),
    )
    expect(rendered[0]).toContain("ui-hero")
    expect(rendered[1]).toContain('hx-post="/action/host"')
    expect(rendered[2]).toContain('<svg role="img"')
    expect(rendered[2]).toContain("Diagram as a list")
    rendered.forEach((page) => {
      expect(page).not.toContain("<script")
      expect(page).not.toContain("javascript:")
      expect(page).not.toContain("https://")
    })
  })

  test("token compilation accepts semantic values and rejects CSS injection", () => {
    const valid = compileDesignTokenCss({
      schemaVersion: 1, id: "test-theme", version: "1.0.0",
      colors: { page: "#000000", surface: "#111111", raised: "#222222", line: "#333333", text: "#ffffff", muted: "#aaaaaa", accent: "#ff7700", success: "#00aa66", warning: "#ddaa00", danger: "#dd3344" },
      typography: { display: "geometric", body: "system", mono: "mono", scale: "standard" }, density: "standard", radius: "soft", shadow: "subtle", motion: "standard",
    })
    expect(Either.isRight(valid)).toBe(true)
    const invalid = compileDesignTokenCss({
      schemaVersion: 1, id: "test-theme", version: "1.0.0",
      colors: { page: "url(https://evil.example)", surface: "#111111", raised: "#222222", line: "#333333", text: "#ffffff", muted: "#aaaaaa", accent: "#ff7700", success: "#00aa66", warning: "#ddaa00", danger: "#dd3344" },
      typography: { display: "geometric", body: "system", mono: "mono", scale: "standard" }, density: "standard", radius: "soft", shadow: "subtle", motion: "standard",
    })
    expect(Either.isLeft(invalid)).toBe(true)
  })
})
