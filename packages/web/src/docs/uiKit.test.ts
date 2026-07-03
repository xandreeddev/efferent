import { describe, expect, test } from "bun:test"
import { RENDER_UI_KIT_DOC } from "./uiKit.js"

/** The doc teaches Tailwind-based page design + the interactive/mermaid
 *  contracts. (Styling is real Tailwind now — no bespoke ef-* kit to cross-
 *  check against CSS.) */
describe("RENDER_UI_KIT_DOC", () => {
  test("teaches Tailwind design, the never-punt rule, mermaid, and the form contract", () => {
    expect(RENDER_UI_KIT_DOC).toContain("Tailwind")
    expect(RENDER_UI_KIT_DOC).toContain("grid grid-cols")
    expect(RENDER_UI_KIT_DOC).toContain("bg-gradient-to")
    // Diagrams via the standard mermaid class (not a chrome-stripped ef-* one).
    expect(RENDER_UI_KIT_DOC).toContain(`<pre class="mermaid">`)
    // The interactive post-back contract survives.
    expect(RENDER_UI_KIT_DOC).toContain(`hx-post="/action/ui"`)
    expect(RENDER_UI_KIT_DOC).toContain("ui-id")
    // Component streaming: build/edit a page by named regions.
    expect(RENDER_UI_KIT_DOC).toContain("region:")
    expect(RENDER_UI_KIT_DOC).toContain("Reuse the EXACT region name to edit")
    // No inline styles / scripts allowed.
    expect(RENDER_UI_KIT_DOC).toContain("NO inline")
    // The bespoke-kit framing is gone.
    expect(RENDER_UI_KIT_DOC).not.toContain("ef-hero")
    expect(RENDER_UI_KIT_DOC).not.toContain("ef-band")
  })
})
