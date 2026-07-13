import { describe, expect, test } from "bun:test"
import { CORE_UI_COMPONENTS, architectureReference, applicationReference, landingReference, normalizeComponentDefinition } from "@xandreed/ui-agent"
import { compileDesignTokenCss, compileThemeCss } from "./designTokens.js"
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

  test("renders a progressive component graph and scoped semantic theme", () => {
    const components = new Map(CORE_UI_COMPONENTS.map(normalizeComponentDefinition).map((definition) => [definition.id, definition]))
    const rendered = renderUiPage({
      manifest: {
        id: "component-page", title: "Component page", archetype: "landing",
        recipe: { id: "landing.hero-grid", version: "2.0.0" }, designSystem: { id: "test", version: "2.0.0" },
        slots: [{ id: "hero", blockKind: "component", component: "marketing.hero", importance: "critical" }],
      },
      blocks: [{ kind: "component", id: "hero", component: "marketing.hero", variant: "split", props: { title: "A real generated page", lede: "Specific content arrives before supporting sections." }, children: ["proof"] }],
      complete: false,
    }, { ...context, components, theme: { id: "theme-1234", href: "/theme/theme-1234.css" } })
    expect(rendered).toContain('data-component="marketing.hero"')
    expect(rendered).toContain('data-pending-node="proof"')
    expect(rendered).toContain('data-ui-theme="theme-1234"')
    expect(rendered).not.toContain("bg-red")

    const theme = compileThemeCss({
      mode: "light", accent: "#356dd0", neutral: "#667085", positive: "#228b55", warning: "#b7791f", danger: "#c53030",
      contrast: "high", surface: "flat", border: "strong", radius: "sharp", shadow: "none", typography: "editorial", typeScale: "spacious", density: "comfortable", motion: "reduced",
    }, '[data-ui-theme="theme-1234"]')
    expect(Either.isRight(theme)).toBe(true)
    expect(Either.getOrElse(theme, () => "")).toContain("--ui-border-width:2px")
  })
})
