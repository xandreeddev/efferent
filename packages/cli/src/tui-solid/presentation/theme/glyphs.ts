import { SPINNER_FRAMES } from "../../../terminal.js"

/**
 * The glyph vocabulary — every box-drawing / marker character the TUI paints,
 * named once. Pure data (string literals), so both the L1 presentation models
 * and the L4 view components share one source and can't drift. The animated
 * spinner frames are re-exported from `terminal.ts` (where print mode also reads
 * them) so callers have a single glyph import.
 */
export const glyph = {
  /** Event-rail dot (assistant prose + tool pills) and the ● loaded-context dot. */
  railDot: "●",
  loaded: "●",
  /** Result connector under a tool header (` ⎿ detail`). */
  connector: "⎿",
  /** Fold carets — open shows children, closed collapses them. */
  fold: { open: "▾", closed: "▸" },
  /** Turn-head anchor bar — the strongest visual landmark in the rail. */
  turnBar: "┃",
  /** Multi-select markers (context viewer pick). */
  select: { on: "◉", off: "○" },
  /** Handoff flag + its summary star (context viewer / checkpoints). */
  handoff: "⚑",
  summary: "✦",
  /** Terminal status ticks for completed tree nodes. */
  ok: "✓",
  error: "✗",
  /** Block cursor for text-entry overlays. */
  cursorBlock: "█",
  /** "More above / below" scroll affordances in windowed lists. */
  more: { above: "↑", below: "↓" },
  /** Row pointer (select list / slash palette / settings cursor). */
  pointer: "▸",
  /** "◀ active" tag marking the current selection in a list. */
  activeTag: "◀",
  /** Context-viewer message-line icons, by role. */
  msg: { user: "❯", assistant: "●", tool: "⚙", result: "↳" },
  /** Animated spinner frames for running tree nodes. */
  spinner: SPINNER_FRAMES,
} as const
