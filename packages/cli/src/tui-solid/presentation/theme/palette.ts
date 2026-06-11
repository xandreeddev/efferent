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

/**
 * **efferent** — the flagship identity. Warm near-black base with an
 * ember / verdigris / chartreuse accent triad: signals travelling outward
 * (ember = the conversation, verdigris = the orchestration pane, chartreuse =
 * your input). Deliberately not another blue-on-slate coding theme — the
 * brand should be recognizable in a 240px screenshot.
 */
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
  bgOverlay: "#26221d", // warm dark — modal background
  bgStatus: "#1c1916", // warm darker — status-bar background
  cursorLine: "#322d26", // focused-row tint
} as const

/** The One-Dark-ish palette (the previous default, kept as a theme). */
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

/**
 * Tokyo Night (night variant) — a cool blue/purple dark palette. Same key set as
 * {@link defaultPalette} (the contract is the palette shape), different values;
 * {@link makeTokens} derives the full token set from it. Two palette hues fold
 * onto two roles each (blue = conversation accent + functions; purple = side
 * accent + keywords), which is idiomatic Tokyo Night.
 */
export const tokyoNightPalette: Palette = {
  cyan: "#7aa2f7", // TN blue — conversation accent / links / assistant
  magenta: "#bb9af7", // TN purple — side accent / handoff / overlay border
  green: "#9ece6a", // TN green — input accent / select marker / cursor
  greenMuted: "#9ece6a", // TN green — tool ok / strings / loaded ●
  yellow: "#e0af68", // TN yellow — running state / types
  red: "#f7768e", // TN red — errors / variables
  blue: "#7aa2f7", // TN blue — turn headers / functions
  purple: "#bb9af7", // TN purple — keywords
  orange: "#ff9e64", // TN orange — numbers / parameters
  teal: "#73daca", // TN teal — escapes / operators
  text: "#c0caf5", // TN fg — primary prose
  textUser: "#a9b1d6", // TN fg-dark — user messages
  gray: "#737aa2", // TN dark5 — secondary / muted text
  dim: "#545c7e", // TN dark3 — unfocused borders / faint hints
  comment: "#565f89", // TN comment
  punctuation: "#a9b1d6", // TN fg-dark — code punctuation
  bgOverlay: "#1f2335", // TN bg-dark — modal background
  bgStatus: "#16161e", // TN bg-darker — status-bar background
  cursorLine: "#2f334d", // TN bg-highlight — focused-row tint
} as const
