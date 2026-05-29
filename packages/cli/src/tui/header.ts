import { ansi, padRight, truncate } from "./terminal.js"
import type { FocusPane, UiMode } from "./uiMode.js"
import type { EntryMode } from "./navKeys.js"

/**
 * The fixed top hint bar. One row, pinned above the conversation (never
 * scrolls). Its contents track the current mode + focused pane, so the
 * available keys are always discoverable.
 */

const hint = (keys: string, label: string): string =>
  `${ansi.bold}${keys}${ansi.reset}${ansi.dim} ${label}${ansi.reset}`

const SEP = `${ansi.dim} · ${ansi.reset}`

/** A bold, coloured badge naming the focused pane — the primary focus signal. */
const paneBadge = (focus: FocusPane): string => {
  const label =
    focus === "conversation" ? " CHAT " : focus === "side" ? " SIDE " : " INPUT "
  return `${ansi.bold}${ansi.bgBrightCyan}${ansi.fgBlack}${label}${ansi.reset}${ansi.bgDarkGray} `
}

export const renderHeader = (
  mode: UiMode,
  focus: FocusPane,
  entry: EntryMode,
  zoomed: boolean,
  cols: number,
): string => {
  let parts: ReadonlyArray<string>
  if (entry === "command") {
    parts = [hint("↵", "run"), hint("Tab", "complete"), hint("Esc", "cancel")]
  } else if (entry === "search") {
    parts = [hint("↵", "jump"), hint("n/N", "next/prev"), hint("Esc", "cancel")]
  } else if (mode === "insert") {
    parts = [
      hint("↵", "send"),
      hint("^J", "newline"),
      hint("Esc", "normal"),
      hint("^h/j/k/l", "pane"),
    ]
  } else if (mode === "visual") {
    parts = [hint("j/k", "extend"), hint("y", "yank"), hint("Esc", "cancel")]
  } else if (focus === "conversation") {
    parts = [
      hint("j/k", "move"),
      hint("gg/G", "ends"),
      hint("{/}", "msg"),
      hint("/", "search"),
      hint("v", "select"),
      hint("z", "zoom"),
      hint("^h/j/k/l", "pane"),
    ]
  } else {
    // input or side, NORMAL
    parts = [
      hint("i", "insert"),
      hint("^h/j/k/l", "pane"),
      hint("z", "zoom"),
      hint("/", "search"),
      hint(":", "cmd"),
    ]
  }
  // Zoom is the dominant state — lead with how to leave it.
  if (zoomed && entry === "message" && mode !== "insert") {
    parts = [hint("z/Esc", "unzoom"), ...parts]
  }
  const line = paneBadge(focus) + parts.join(SEP)
  return `${ansi.bgDarkGray}${padRight(truncate(line, cols), cols)}${ansi.reset}`
}
