import { describe, expect, test } from "bun:test"
import { RENDER_UI_KIT_DOC } from "./uiKit.js"
import { staticAssets } from "../assets/static.js"

/** The doc ↔ css contract: every ef-* class the kit doc names must exist in
 *  the served stylesheets — the agent styles ONLY with classes we ship. */
describe("RENDER_UI_KIT_DOC", () => {
  test("every documented ef-* class exists in kit.css or app.css", () => {
    const css = ["kit.css", "app.css"]
      .map((n) => staticAssets.find((a) => a.path.endsWith(`/${n}`))?.content ?? "")
      .join("\n")
    // The doc's ANTI-examples — utility-style names it explicitly says do
    // NOT exist (they must stay out of the css, by design). Layout aliases
    // (ef-grid-cols-3, ef-flex) are NOT anti-examples — they now work.
    const antiExamples = new Set(["ef-text-xl", "ef-py-6", "ef-mb-4", "ef-w-full", "ef-uppercase"])
    const classes = new Set(
      [...RENDER_UI_KIT_DOC.matchAll(/\bef-[a-z0-9-]+(?:--[a-z0-9-]+)?\b/g)].map((m) => m[0]),
    )
    expect(classes.size).toBeGreaterThan(20)
    const missing = [...classes].filter((c) => {
      if (antiExamples.has(c)) return false
      // A modifier documented as `--warn` rides its base class; full names check directly.
      const name = c.startsWith("ef-") ? c : `ef-${c}`
      return !css.includes(`.${name}`)
    })
    expect(missing).toEqual([])
    for (const anti of antiExamples) expect(css).not.toContain(`.${anti} `)
  })

  test("the doc teaches pages + never-punt + mermaid + viewing context", () => {
    expect(RENDER_UI_KIT_DOC).toContain("you build pages")
    expect(RENDER_UI_KIT_DOC).toContain("NEVER write an .md/.html file")
    expect(RENDER_UI_KIT_DOC).toContain("ef-mermaid")
    expect(RENDER_UI_KIT_DOC).toContain("[viewing:<page-id>]")
    expect(RENDER_UI_KIT_DOC).toContain(`hx-post="/action/ui"`)
    expect(RENDER_UI_KIT_DOC).toContain("ui-id")
    // The card-scale framing is the anti-pattern now — it must be gone.
    expect(RENDER_UI_KIT_DOC).not.toContain("Keep cards small")
  })
})
