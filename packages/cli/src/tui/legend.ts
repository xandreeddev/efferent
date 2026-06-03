import { ansi, visibleLength } from "./terminal.js"
import type { FocusPane, UiMode } from "./uiMode.js"
import type { EntryMode } from "./navKeys.js"

/**
 * The always-on, per-pane keybinds. Rendered as a bordered box (by render.ts)
 * whose border + title take the focused pane's accent colour; the title carries
 * the focused pane + mode (e.g. `conversation · NORMAL`).
 *
 * The body is **two labelled rows**: a fixed `nav` row (the global movement set
 * — pane switching / `:` / `/` / zoom, identical in every pane) over a dynamic
 * row of the focused pane's own keys. A `:`/`/` entry is a focused prompt, so it
 * takes the top row (labelled `cmd`/`find`) and blanks the bottom one.
 */
/** Key content rows inside the keybind box. */
export const KEYBIND_KEY_ROWS = 2
/** Total keybind box height: top border + key rows + bottom border. */
export const KEYBIND_BOX_ROWS = KEYBIND_KEY_ROWS + 2

/** Width of the dim row label (`nav`/`pane`/…); a trailing space follows it. */
const LABEL_W = 4

const modeLabel = (mode: UiMode): string =>
  mode === "insert" ? "INSERT" : mode === "visual" ? "VISUAL" : "NORMAL"

/** One legend row: a short dim label + the keys it advertises. */
interface LegendRow {
  readonly label: string
  readonly keys: readonly string[]
}

/** Pane switching — Ctrl + hjkl or Ctrl + arrows (peers). */
const PANE_KEY = "^hjkl/↑↓←→ panes"

/** Global navigation keys — identical across the read-only panes. */
const NAV_KEYS = [PANE_KEY, ": cmd", "/ search", "z zoom"]

/**
 * The two rows for the current pane/mode/entry: a fixed `nav` row over a dynamic
 * row of the focused pane's keys. `↵`/`⇥`/arrow glyphs read the same as the keys
 * `decideKey` actually accepts (arrows are peers of hjkl).
 */
const legendRows = (
  focus: FocusPane,
  mode: UiMode,
  view: "stack" | "context",
  entry: EntryMode,
): readonly [LegendRow, LegendRow] => {
  if (entry === "command") {
    return [
      { label: "cmd", keys: ["↵ run", "Tab complete", "Esc cancel"] },
      { label: "", keys: [] },
    ]
  }
  if (entry === "search") {
    return [
      { label: "find", keys: ["↵ jump", "n/N next·prev", "Esc cancel"] },
      { label: "", keys: [] },
    ]
  }
  if (focus === "input") {
    const nav: LegendRow = { label: "nav", keys: [PANE_KEY, ": cmd", "/ search"] }
    return mode === "insert"
      ? [nav, { label: "input", keys: ["type to compose", "Esc → NORMAL"] }]
      : [nav, { label: "input", keys: ["↵ send", "i insert"] }]
  }
  if (focus === "conversation") {
    return mode === "visual"
      ? [
          { label: "nav", keys: [PANE_KEY] },
          { label: "vis", keys: ["hjkl/↑↓←→ extend", "y yank", "v/V switch", "Esc cancel"] },
        ]
      : [
          { label: "nav", keys: NAV_KEYS },
          {
            label: "pane",
            keys: [
              "hjkl/↑↓←→ move",
              "w/b/e word",
              "⇥ fold",
              "⇧T effort",
              "Z fold all",
              "{ } turn",
              "v/V select",
              "i insert",
            ],
          },
        ]
  }
  // Side pane: context viewer vs activity (stack) view.
  return view === "context"
    ? [
        { label: "nav", keys: NAV_KEYS },
        {
          label: "ctx",
          keys: ["j/k/↑↓ move", "h/l/←→ fold", "↵ jump", "Space select", "b build", "i insert"],
        },
      ]
    : [
        { label: "nav", keys: NAV_KEYS },
        { label: "act", keys: ["j/k/↑↓ move", "⇥/↵/←→ fold", "i insert"] },
      ]
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

/** Visible gray vertical bar between commands (the dim `·` read as invisible). */
const SEP = `${ansi.fgGray} │ ${ansi.reset}`

const styleKeyLine = (line: string): string => {
  // Bold key tokens (first word of each item), dim the descriptive words, with a
  // clearly-visible bar between commands.
  return line
    .split(" · ")
    .map((item) => {
      const sp = item.indexOf(" ")
      if (sp === -1) return `${ansi.bold}${item}${ansi.reset}`
      const key = item.slice(0, sp)
      const desc = item.slice(sp + 1)
      return `${ansi.bold}${key}${ansi.reset} ${ansi.dim}${desc}${ansi.reset}`
    })
    .join(SEP)
}

/** A dim, fixed-width row label (`nav`/`pane`/…) with a trailing gutter space. */
const styleLabel = (label: string): string =>
  `${ansi.dim}${label.padEnd(LABEL_W)}${ansi.reset} `

/**
 * The keybind box's content: a `title` (focused pane · MODE, e.g.
 * `conversation · NORMAL`) for the box border, plus two labelled rows — a fixed
 * `nav` line over the focused pane's own keys — packed to `innerWidth`. render.ts
 * frames these in a box coloured by the focused pane's accent.
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
  const keysWidth = Math.max(1, innerWidth - LABEL_W - 1)
  const renderRow = (row: LegendRow): string => {
    const packed = packRows([...row.keys], keysWidth, 1)[0] ?? ""
    const keys = packed.length > 0 ? styleKeyLine(packed) : ""
    return `${styleLabel(row.label)}${keys}`
  }
  const [r1, r2] = legendRows(focus, mode, view, entry)
  return { title, rows: [renderRow(r1), renderRow(r2)] }
}
