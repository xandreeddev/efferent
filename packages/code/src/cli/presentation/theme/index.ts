/**
 * The TUI design system — a single import surface for the two-tier token model.
 *
 *   palette (raw hexes, named once)  →  tokens (semantic roles)  →  views
 *   glyph   (named characters)                                   ↗
 *
 * Views and view-primitives import {@link tokens} / {@link glyph} (never a raw
 * hex or a palette entry); `view/syntax.ts` builds its `SyntaxStyle` from
 * `tokens.syntax`. Re-theming is one swap of the palette in `tokens.ts`.
 */
export { type Palette, defaultPalette, BRAND } from "./palette.js"
export { type Tokens, type SyntaxTokens, type PaneKind, makeTokens } from "./tokens.js"
export {
  type Theme,
  themes,
  activeTheme,
  activeThemeName,
  tokens,
  paneBorder,
} from "./themes.js"
export { glyph } from "./glyphs.js"
