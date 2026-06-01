import { ansi, visibleLength } from "./terminal.js"
import type { FocusPane, UiMode } from "./uiMode.js"
import type { EntryMode } from "./navKeys.js"

/**
 * The always-on, per-pane keybinds. Rendered as a bordered box (by render.ts)
 * whose border + title take the focused pane's accent colour; the title carries
 * the focused pane + mode (e.g. `conversation · NORMAL`), and the body rows are
 * the keys that pane actually accepts — so it doubles as live help.
 */
/** Key content rows inside the keybind box. */
export const KEYBIND_KEY_ROWS = 2
/** Total keybind box height: top border + key rows + bottom border. */
export const KEYBIND_BOX_ROWS = KEYBIND_KEY_ROWS + 2

const modeLabel = (mode: UiMode): string =>
  mode === "insert" ? "INSERT" : mode === "visual" ? "VISUAL" : "NORMAL"

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
    ? ["j/k move", "Space select", "b build session", "⇥/h/l fold", "↵ jump", "z zoom", "^h/j/k/l panes", "i insert"]
    : ["z zoom", ": command", "^h/j/k/l panes", "i insert"]
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

/**
 * The keybind box's content: a `title` (focused pane · MODE, e.g.
 * `conversation · NORMAL`) for the box border, plus `rows` of styled key hints
 * packed to `innerWidth`. render.ts frames these in a box coloured by the
 * focused pane's accent.
 */
export const legendContent = (
  focus: FocusPane,
  mode: UiMode,
  view: "stack" | "context",
  entry: EntryMode,
  innerWidth: number,
): { title: string; rows: string[] } => {
  const paneName =
    focus === "conversation"
      ? "conversation"
      : focus === "side"
        ? view === "context"
          ? "context"
          : "side"
        : "input"
  const title = `${paneName} · ${modeLabel(mode)}`
  const keyRows = packRows(keysFor(focus, mode, view, entry), innerWidth, KEYBIND_KEY_ROWS)
  const rows = keyRows.map((l) => styleKeyLine(l))
  while (rows.length < KEYBIND_KEY_ROWS) rows.push("")
  return { title, rows: rows.slice(0, KEYBIND_KEY_ROWS) }
}
