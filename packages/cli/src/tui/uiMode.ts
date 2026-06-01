/**
 * The TUI is modal and multi-pane (vim-flavoured). One pane has focus at a
 * time; the focused pane has a mode. INSERT only exists on the input pane;
 * the read-only panes (conversation, side) are NORMAL or VISUAL only.
 */

export type UiMode = "insert" | "normal" | "visual"

export type FocusPane = "conversation" | "side" | "input"

export type ModeLabel = "INS" | "NOR" | "VIS"

export const modeLabel = (mode: UiMode): ModeLabel =>
  mode === "insert" ? "INS" : mode === "visual" ? "VIS" : "NOR"

/**
 * Directional focus movement (Ctrl-h/j/k/l). Layout:
 *
 *   ┌──────────────┬──────┐
 *   │ conversation │ side │
 *   ├──────────────┴──────┤
 *   │ input               │
 *   └─────────────────────┘
 *
 * Returns the new focus, or the same pane when there's nothing that way.
 * `sideVisible` is false on narrow terminals (no side pane), so h/l there
 * keep focus on the conversation.
 */
export const moveFocus = (
  focus: FocusPane,
  dir: "left" | "right" | "up" | "down",
  sideVisible: boolean,
): FocusPane => {
  switch (focus) {
    case "conversation":
      if (dir === "right" && sideVisible) return "side"
      if (dir === "down") return "input"
      return "conversation"
    case "side":
      if (dir === "left") return "conversation"
      if (dir === "down") return "input"
      return "side"
    case "input":
      if (dir === "up") return "conversation"
      if (dir === "right" && sideVisible) return "side"
      return "input"
  }
}
