import { ansi, padRight, truncate } from "./terminal.js"
import type { FocusPane, UiMode } from "./uiMode.js"

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
  return `${ansi.bold}${ansi.bgBlue}${ansi.fgWhite}${label}${ansi.reset}${ansi.bgDarkGray} `
}

export const renderHeader = (
  mode: UiMode,
  focus: FocusPane,
  searching: boolean,
  cols: number,
): string => {
  let parts: ReadonlyArray<string>
  if (searching) {
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
      hint("j/k", "scroll"),
      hint("gg/G", "ends"),
      hint("{/}", "msg"),
      hint("/", "search"),
      hint("v", "select"),
      hint("^h/j/k/l", "pane"),
      hint(":", "cmd"),
    ]
  } else {
    // input or side, NORMAL
    parts = [
      hint("i", "insert"),
      hint("^h/j/k/l", "pane"),
      hint("/", "search"),
      hint(":", "cmd"),
    ]
  }
  const line = paneBadge(focus) + parts.join(SEP)
  return `${ansi.bgDarkGray}${padRight(truncate(line, cols), cols)}${ansi.reset}`
}
