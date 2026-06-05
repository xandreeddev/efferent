import { defaultPalette, tokyoNightPalette } from "./palette.js"
import { makeTokens, type PaneKind, type Tokens } from "./tokens.js"

/**
 * A **theme** is one complete set of values for the semantic {@link Tokens} — the
 * token *names* are fixed (the stable interface every view paints against), and a
 * theme supplies the values. themeA defines `accent`/`text`/`state`/…; themeB
 * defines those same tokens with different values. Swap the active theme and
 * every token (and so every view) re-resolves. "Swap the values, voilà."
 *
 * How a theme authors its values is its own business: the built-in `one-dark`
 * derives them from a small palette via {@link makeTokens} (DRY), but a theme
 * could hand-author its `Tokens` just as well — the contract is the token set.
 *
 * To add a theme: add a `{ name, tokens }` entry to {@link themes}. To switch:
 * point {@link activeThemeName} at it. (A runtime `:theme` picker /
 * `~/.efferent/theme.json` is the deferred next step — it only has to reassign
 * the active theme; everything downstream already reads the one `tokens` seam.)
 */
export interface Theme {
  readonly name: string
  readonly tokens: Tokens
}

/** The theme registry, keyed by name. The runtime `:theme` picker lists these. */
export const themes: Record<string, Theme> = {
  "one-dark": { name: "one-dark", tokens: makeTokens(defaultPalette) },
  "tokyo-night": { name: "tokyo-night", tokens: makeTokens(tokyoNightPalette) },
}

/** The default theme's name — the static fallback. At runtime, `state/theme.ts`
 *  wraps this in a Solid signal so `:theme` can switch it live. */
export const activeThemeName = "one-dark"

/** The resolved active theme. */
export const activeTheme: Theme =
  themes[activeThemeName] ?? { name: "one-dark", tokens: makeTokens(defaultPalette) }

/** The active semantic tokens — what every view imports. Same names across
 *  themes; values from {@link activeTheme}. */
export const tokens: Tokens = activeTheme.tokens

/** The focused box's accent; the unfocused border colour otherwise. */
export const paneBorder = (pane: PaneKind, focused: boolean): string =>
  focused ? tokens.accent[pane] : tokens.border.unfocused
