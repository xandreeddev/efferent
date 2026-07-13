import { describe, expect, test } from "bun:test"
import { CORE_UI_COMPONENTS } from "./domain/core-components.functions.js"
import { admitComponent, componentFingerprint, normalizeComponentDefinition, retrieveComponents, validateComponentDefinition, validateComponentProps } from "./domain/ui-component.entity.functions.js"
import { applyThemeDelta, themeFingerprint, validateThemeIntent } from "./domain/design-system.entity.functions.js"

describe("the evolutionary component and theme domain", () => {
  test("the core catalog is broad, canonical and fingerprinted", () => {
    const normalized = CORE_UI_COMPONENTS.map(normalizeComponentDefinition)
    expect(normalized.length).toBeGreaterThanOrEqual(60)
    expect(new Set(normalized.map((definition) => definition.id)).size).toBe(normalized.length)
    expect(normalized.every((definition) => definition.fingerprint === componentFingerprint(definition))).toBe(true)
    expect(normalized.every((definition) => validateComponentDefinition(definition).length === 0)).toBe(true)
  })

  test("equivalent anatomy reuses one component instead of growing the catalog", () => {
    const base = normalizeComponentDefinition(CORE_UI_COMPONENTS.find((definition) => definition.id === "marketing.feature-grid")!)
    const candidate = { ...base, id: "workspace.another-feature-grid", status: "candidate" as const, description: "Different copy and intended theme", createdAt: 10, fingerprint: undefined }
    const admitted = admitComponent(candidate, [base])
    expect(admitted.disposition).toBe("reused")
    expect(admitted.canonicalId).toBe("marketing.feature-grid")
  })

  test("typed props reject undeclared and malformed model output", () => {
    const hero = CORE_UI_COMPONENTS.find((definition) => definition.id === "marketing.hero")!
    expect(validateComponentProps(hero, { title: "Specific product", lede: "Useful explanation" })).toEqual([])
    expect(validateComponentProps(hero, { title: 42, class: "bg-red-500" })).toContain("marketing.hero.title must be string")
    expect(validateComponentProps(hero, { title: 42, class: "bg-red-500" })).toContain("marketing.hero.class is not a declared prop")
  })

  test("catalog retrieval stays bounded while finding relevant capabilities", () => {
    const selected = retrieveComponents(CORE_UI_COMPONENTS, "Build a pricing comparison landing page", 12)
    expect(selected).toHaveLength(12)
    expect(selected.some((definition) => definition.id === "marketing.pricing")).toBe(true)
  })

  test("theme deltas change presentation without changing component identity", () => {
    const base = {
      mode: "dark" as const, accent: "#e57b45", neutral: "#59647a", positive: "#73b88a", warning: "#e4b95f", danger: "#dd6b72",
      contrast: "standard" as const, surface: "layered" as const, border: "subtle" as const, radius: "soft" as const, shadow: "layered" as const,
      typography: "geometric" as const, typeScale: "standard" as const, density: "standard" as const, motion: "standard" as const,
    }
    const editorial = applyThemeDelta(base, { typography: "editorial", border: "strong", radius: "sharp", accent: "#356dd0" })
    expect(validateThemeIntent(editorial)).toEqual([])
    expect(themeFingerprint(editorial)).not.toBe(themeFingerprint(base))
    expect(editorial.typography).toBe("editorial")
  })
})
