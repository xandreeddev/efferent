import { describe, expect, test } from "bun:test"
import { renderTokensCss, flattenTokens } from "./css.js"
import { webThemes } from "./themes.js"

describe("theme css", () => {
  test("flattens nested tokens with dash-joined stable names", () => {
    const theme = webThemes[0]
    if (theme === undefined) throw new Error("no themes")
    const names = flattenTokens(theme.tokens).map(([n]) => n)
    for (const expected of [
      "--tok-accent-conversation",
      "--tok-text-muted",
      "--tok-state-running",
      "--tok-match-word-bg",
      "--tok-surface-panel",
      "--tok-syntax-keyword",
      "--tok-cursorLine",
    ]) {
      expect(names).toContain(expected)
    }
  })

  test("every theme flattens to the same token-name set (stable contract)", () => {
    const sets = webThemes.map((t) => flattenTokens(t.tokens).map(([n]) => n).join("|"))
    expect(new Set(sets).size).toBe(1)
  })

  test("css contains :root default plus a block per theme", () => {
    const css = renderTokensCss()
    expect(css).toContain(":root {")
    expect(css).toContain(':root[data-theme="efferent"]')
    expect(css).toContain(':root[data-theme="one-dark"]')
    expect(css).toContain(':root[data-theme="tokyo-night"]')
    // spot value: the efferent ember accent
    expect(css).toContain("--tok-accent-conversation: #ffa657;")
  })

  test("all values are hex colours (no accidental structure leaks)", () => {
    for (const theme of webThemes) {
      for (const [, value] of flattenTokens(theme.tokens)) {
        // 6-digit, or 8-digit for the translucent elevation shadow.
        expect(value).toMatch(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/)
      }
    }
  })
})
