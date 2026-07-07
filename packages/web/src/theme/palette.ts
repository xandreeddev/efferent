/**
 * MIRROR OF packages/cli/src/cli/presentation/theme/palette.ts — keep in sync.
 * (This package may not import from the cli, so the three palettes are copied
 * verbatim; a change there must land here in the same commit. The web-only
 * addition is `WebSurfaces` — real backgrounds a browser needs where the
 * terminal just inherits.)
 */
export interface Palette {
  readonly cyan: string
  readonly magenta: string
  readonly green: string
  readonly greenMuted: string
  readonly yellow: string
  readonly red: string
  readonly blue: string
  readonly purple: string
  readonly orange: string
  readonly teal: string
  readonly text: string
  readonly textUser: string
  readonly gray: string
  readonly dim: string
  readonly comment: string
  readonly punctuation: string
  readonly bgStatus: string
  readonly cursorLine: string
  readonly matchLine: string
  readonly matchLineCurrent: string
}

/** Web-only surface tier: page < panel < raised, plus the hairline border and
 *  the elevation shadow (translucent — drawers/dock float over the stage). */
export interface WebSurfaces {
  readonly page: string
  readonly panel: string
  readonly raised: string
  readonly border: string
  readonly shadow: string
}

/** efferent — warm near-black, ember/verdigris/chartreuse accent triad. */
export const efferentPalette: Palette = {
  cyan: "#ffa657", // ember — conversation accent / links / assistant voice
  magenta: "#2dd4bf", // verdigris — side accent / handoff / overlay border
  green: "#a3e635", // chartreuse — input accent / select marker / cursor
  greenMuted: "#8ec07c", // sage — tool ok / strings / loaded ●
  yellow: "#e3b341", // amber — running state / types
  red: "#f47067", // coral — errors / variables
  blue: "#6cb6ff", // sky — turn headers / functions
  purple: "#dcbdfb", // lilac — keywords
  orange: "#f69d50", // tangerine — numbers / parameters
  teal: "#39c5cf", // lagoon — escapes / operators
  text: "#e6e1d9", // warm white — primary prose
  textUser: "#cfc9c0", // warm gray — user messages
  gray: "#9e9a93", // secondary / muted text
  dim: "#6e6a63", // unfocused borders / faint hints
  comment: "#857f76", // code comments
  punctuation: "#b3aea6", // code punctuation/brackets
  bgStatus: "#1c1916", // warm darkest — status base
  cursorLine: "#322d26", // focused-row tint
  matchLine: "#3a321d", // dark amber — search match row
  matchLineCurrent: "#5a4a1f", // brighter amber — the current match
} as const

/** efferent surfaces — the warm near-black family around `bgStatus`. */
export const efferentSurfaces: WebSurfaces = {
  page: "#14120f",
  panel: "#1c1916",
  raised: "#24201b",
  border: "#322d26",
  shadow: "#0a0806cc",
} as const

/** One-Dark-ish (the previous TUI default, kept as a theme). */
export const defaultPalette: Palette = {
  cyan: "#5fd7ff",
  magenta: "#ff5fff",
  green: "#5fff87",
  greenMuted: "#98c379",
  yellow: "#e5c07b",
  red: "#e06c75",
  blue: "#61afef",
  purple: "#c678dd",
  orange: "#d19a66",
  teal: "#56b6c2",
  text: "#d4d4d4",
  textUser: "#c8c8c8",
  gray: "#9ca3af",
  dim: "#6b7280",
  comment: "#7f848e",
  punctuation: "#abb2bf",
  bgStatus: "#1f2430",
  cursorLine: "#2d2d3d",
  matchLine: "#314365",
  matchLineCurrent: "#42557b",
} as const

/** one-dark surfaces — the cool slate family around `bgStatus`. */
export const defaultSurfaces: WebSurfaces = {
  page: "#181c26",
  panel: "#1f2430",
  raised: "#272d3b",
  border: "#2d2d3d",
  shadow: "#0c0e14cc",
} as const

/** Tokyo Night (night variant). */
export const tokyoNightPalette: Palette = {
  cyan: "#7aa2f7",
  magenta: "#bb9af7",
  green: "#9ece6a",
  greenMuted: "#9ece6a",
  yellow: "#e0af68",
  red: "#f7768e",
  blue: "#7aa2f7",
  purple: "#bb9af7",
  orange: "#ff9e64",
  teal: "#73daca",
  text: "#c0caf5",
  textUser: "#a9b1d6",
  gray: "#737aa2",
  dim: "#545c7e",
  comment: "#565f89",
  punctuation: "#a9b1d6",
  bgStatus: "#16161e",
  cursorLine: "#2f334d",
  matchLine: "#283457",
  matchLineCurrent: "#3d59a1",
} as const

/** tokyo-night surfaces — the TN storm/night family around `bgStatus`. */
export const tokyoNightSurfaces: WebSurfaces = {
  page: "#111117",
  panel: "#16161e",
  raised: "#1d1d28",
  border: "#2f334d",
  shadow: "#0a0a10cc",
} as const
