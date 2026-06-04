/**
 * Colour vocabulary for the Solid/OpenTUI TUI, mirroring the old hand-rolled
 * `PANE_ACCENT` + event-rail colours (`render.ts:102`, `scrollback.ts`). OpenTUI
 * takes hex strings as `ColorInput`, so the named ANSI accents become hexes.
 */
export const theme = {
  /** Per-pane focus accents — the focused box's border + title brighten to these. */
  accent: {
    conversation: "#5fd7ff", // bright cyan
    side: "#ff5fff", // bright magenta
    input: "#5fff87", // bright green
  },
  /** Unfocused border / dim chrome. */
  dim: "#6b7280",
  gray: "#9ca3af",
  /** Event-rail dot colours, by tool pill state. */
  tool: {
    running: "#e5c07b", // yellow
    ok: "#98c379", // green
    error: "#e06c75", // red
  },
  /** Assistant prose leading dot + turn header. */
  assistant: "#5fd7ff",
  turnHeader: "#61afef", // bright blue
  text: "#d4d4d4",
  user: "#c8c8c8",
  error: "#e06c75",
  info: "#9ca3af",
  /** Context viewer: selection ◉, handoff ⚑/✦, loaded ●, cursor-line tint. */
  green: "#98c379",
  select: "#5fff87", // bright green — the ◉ pick marker
  magenta: "#ff5fff", // bright magenta — handoff ⚑ / summary ✦
  cursorLine: "#2d2d3d", // the focused-row background tint
  /** Modal overlay (select/prompt/login) background — opaque, floats over panes. */
  overlayBg: "#23232e",
} as const

export type PaneKind = keyof typeof theme.accent

/** The focused box's accent; dim when unfocused. */
export const paneBorder = (pane: PaneKind, focused: boolean): string =>
  focused ? theme.accent[pane] : theme.dim
