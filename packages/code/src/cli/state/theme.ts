import { createSignal } from "solid-js"
import {
  activeTheme as defaultTheme,
  BRAND,
  glyph,
  themes,
  type PaneKind,
  type Theme,
  type Tokens,
} from "../presentation/theme/index.js"

/**
 * The runtime-reactive theme seam — the one place that turns the otherwise
 * *static* design system into a switchable one.
 *
 * `presentation/theme/` is PURE L1: it names the palette, the semantic token
 * shape, and the theme registry, but `tokens` there is a module const baked at
 * import. To switch themes live we need a Solid signal, and Solid may not live in
 * `presentation/`. So this L2 module holds the **process-global** active-theme
 * signal and re-exports a *reactive* `tokens`/`paneBorder` that every view reads.
 *
 * Why global rather than a per-store slice: the `tokens` below are imported
 * directly by ~16 view modules that hold no store reference, so their backing
 * signal must be module-global too (the theme is genuinely process-wide, like the
 * syntax-highlight client). Views read it; `actions/theme.ts` writes it.
 */
const [activeTheme, setActiveTheme] = createSignal<Theme>(defaultTheme)

export { activeTheme }

/** The active theme's name (reactive). */
export const activeThemeName = (): string => activeTheme().name

/** Every registered theme name, in registry order — the `:theme` picker's list. */
export const themeNames = (): ReadonlyArray<string> => Object.keys(themes)

/**
 * Switch the active theme by name. Every view that paints with a token re-renders
 * on the next frame (the `tokens` proxy below reads the signal). Returns `false`
 * for an unknown name so the caller can surface a hint instead of silently no-op.
 */
export const setTheme = (name: string): boolean => {
  const next = themes[name]
  if (next === undefined) return false
  setActiveTheme(next)
  return true
}

/**
 * The semantic tokens, **reactive**. A `Proxy` so every top-level group access
 * (`tokens.text`, `tokens.accent`, `tokens.syntax`, …) reads the active-theme
 * signal — any view reading a token inside a tracked scope (JSX) re-renders when
 * the theme changes, with **zero call-site changes**: consumers still write
 * `tokens.text.default`. Same shape as the static {@link Tokens}; the proxy only
 * swaps where the values are sourced from.
 */
export const tokens: Tokens = new Proxy({} as Tokens, {
  get: (_target, prop) => activeTheme().tokens[prop as keyof Tokens],
})

/**
 * The focused pane's accent, else the unfocused border colour — reactive (reads
 * the proxy, so a focused border follows a `:theme` switch). Mirrors the static
 * `paneBorder` in `presentation/theme/`, but bound to the live tokens.
 */
export const paneBorder = (pane: PaneKind, focused: boolean): string =>
  focused ? tokens.accent[pane] : tokens.border.unfocused

// The glyph vocabulary is static (a theme is colours, not box-drawing), but
// re-exported here so a view's single `from "…/state/theme.js"` import still
// covers both `glyph` and `tokens`.
export { glyph, BRAND }
export type { PaneKind, Theme, Tokens }
