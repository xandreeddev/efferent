import { ansi, padRight, truncate, visibleLength } from "./terminal.js"
import type { FocusPane, UiMode } from "./uiMode.js"
import type { EntryMode } from "./navKeys.js"

/**
 * The always-on, per-pane keybind legend that sits fixed above the input — the
 * "fixed instructions". Row 1 is the mode badge + focused pane; rows 2–3 are
 * the keys that pane actually accepts, so it doubles as live help.
 */
export const LEGEND_ROWS = 3

const modeLabel = (mode: UiMode): string =>
  mode === "insert" ? "INSERT" : mode === "visual" ? "VISUAL" : "NORMAL"

const modeBadge = (mode: UiMode): string => {
  const bg =
    mode === "insert"
      ? ansi.bgBrightGreen
      : mode === "visual"
        ? ansi.bgBrightYellow
        : ansi.bgBrightCyan
  return `${ansi.bold}${bg}${ansi.fgBlack} ${modeLabel(mode)} ${ansi.reset}`
}

/** The keys to advertise for the current pane/mode/entry, in priority order. */
const keysFor = (
  focus: FocusPane,
  mode: UiMode,
  view: "stack" | "context",
  entry: EntryMode,
): string[] => {
  if (entry === "command") return ["↵ run", "Tab complete", "Esc cancel"]
  if (entry === "search") return ["↵ jump", "n/N next·prev", "Esc cancel"]
  if (focus === "input") {
    return mode === "insert"
      ? ["type to compose", "Esc → NORMAL", "^h/j/k/l panes"]
      : ["↵ send", "i insert", ": command", "/ search", "^h/j/k/l panes"]
  }
  if (focus === "conversation") {
    return mode === "visual"
      ? ["h/j/k/l extend", "y yank", "v/V switch", "Esc cancel"]
      : [
          "h/j/k/l move",
          "w/b/e word",
          "⇥ fold",
          "Z fold all",
          "{ } turn",
          "/ search",
          "v/V select",
          "z zoom",
          "^h/j/k/l panes",
          "i insert",
        ]
  }
  // side pane
  return view === "context"
    ? ["j/k move", "⇥/h/l fold", "↵ jump to message", "z zoom", "^h/j/k/l panes", "i insert"]
    : ["j/k scroll", "z zoom", ": command", "^h/j/k/l panes", "i insert"]
}

/** Greedy-pack labels into at most `rows` lines, each ≤ `width`, joined by ` · `. */
const packRows = (labels: string[], width: number, rows: number): string[] => {
  const sep = " · "
  const out: string[] = []
  let line = ""
  for (const label of labels) {
    const candidate = line.length === 0 ? label : line + sep + label
    if (visibleLength(candidate) > width && line.length > 0) {
      out.push(line)
      line = label
      if (out.length === rows - 1) {
        // last available row: keep filling, truncation handled by caller
      }
    } else {
      line = candidate
    }
  }
  if (line.length > 0) out.push(line)
  return out.slice(0, rows)
}

const styleKeyLine = (line: string): string => {
  // Dim the descriptive words; leave the key tokens (first word of each item) plain.
  return line
    .split(" · ")
    .map((item) => {
      const sp = item.indexOf(" ")
      if (sp === -1) return `${ansi.bold}${item}${ansi.reset}`
      const key = item.slice(0, sp)
      const desc = item.slice(sp + 1)
      return `${ansi.bold}${key}${ansi.reset} ${ansi.dim}${desc}${ansi.reset}`
    })
    .join(`${ansi.dim} · ${ansi.reset}`)
}

export const renderLegend = (
  focus: FocusPane,
  mode: UiMode,
  view: "stack" | "context",
  entry: EntryMode,
  cols: number,
): string[] => {
  const paneName =
    focus === "conversation"
      ? "conversation"
      : focus === "side"
        ? view === "context"
          ? "context"
          : "side"
        : "input"
  const row1 = `${modeBadge(mode)} ${ansi.dim}·${ansi.reset} ${ansi.bold}${ansi.fgBrightCyan}${paneName}${ansi.reset}`

  const keyRows = packRows(keysFor(focus, mode, view, entry), cols - 2, LEGEND_ROWS - 1)
  const styled = keyRows.map((l) => " " + styleKeyLine(l))

  const out = [" " + row1, ...styled]
  while (out.length < LEGEND_ROWS) out.push("")
  return out.slice(0, LEGEND_ROWS).map((l) => padRight(truncate(l, cols), cols))
}
