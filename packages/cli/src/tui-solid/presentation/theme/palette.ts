/**
 * Tier 1 of the two-tier design system: the **palette** — every raw colour the
 * TUI uses, named exactly once. Nothing else in the tree should hold a hex
 * literal; semantic roles ({@link ./tokens.ts}) and code-scope colours both
 * reference these primitives, so a re-theme is a single palette swap.
 *
 * OpenTUI takes hex strings as `ColorInput`. The set is a One-Dark-ish family:
 * the three bright pane accents (cyan/magenta/green) plus the muted One-Dark
 * code colours shared by the syntax highlighter and the chrome.
 */
export interface Palette {
  /** Bright accents — the focused-pane borders + primary highlights. */
  readonly cyan: string
  readonly magenta: string
  readonly green: string
  /** Muted One-Dark family — tool states, code scopes, secondary text. */
  readonly greenMuted: string
  readonly yellow: string
  readonly red: string
  readonly blue: string
  readonly purple: string
  readonly orange: string
  readonly teal: string
  /** Text & neutrals. */
  readonly text: string
  readonly textUser: string
  readonly gray: string
  readonly dim: string
  readonly comment: string
  readonly punctuation: string
  /** Surfaces — modal + status-bar backgrounds and the cursor-row tint. */
  readonly bgOverlay: string
  readonly bgStatus: string
  readonly cursorLine: string
}

/** The default (and currently only) palette — the One-Dark-ish set. */
export const defaultPalette: Palette = {
  cyan: "#5fd7ff", // bright cyan — conversation accent / links
  magenta: "#ff5fff", // bright magenta — side accent / handoff
  green: "#5fff87", // bright green — input accent / select marker / cursor
  greenMuted: "#98c379", // One-Dark green — tool ok / strings / loaded ●
  yellow: "#e5c07b", // One-Dark yellow — running state / types
  red: "#e06c75", // One-Dark red — errors / variables
  blue: "#61afef", // One-Dark blue — turn headers / functions
  purple: "#c678dd", // One-Dark purple — keywords
  orange: "#d19a66", // One-Dark orange — numbers / parameters
  teal: "#56b6c2", // One-Dark cyan — escapes / operators
  text: "#d4d4d4", // primary prose
  textUser: "#c8c8c8", // user messages
  gray: "#9ca3af", // secondary text / muted
  dim: "#6b7280", // unfocused borders / faint hints
  comment: "#7f848e", // code comments
  punctuation: "#abb2bf", // code punctuation/brackets
  bgOverlay: "#23232e", // modal background (opaque, floats over panes)
  bgStatus: "#1f2430", // status-bar background
  cursorLine: "#2d2d3d", // focused-row background tint
} as const
