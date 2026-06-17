/**
 * The `:help` / `?` reference overlay — a tabbed, scrollable list of every `:`
 * command and every keybind (matches the Antigravity CLI's tabbed help). Pure:
 * state + the catalogue + a flat-row derivation the view windows by `scroll`.
 *
 * The keybind catalogue here is the documented **source of truth** for the
 * reference surface; the actual dispatch lives in `keys/dispatch.ts` /
 * `keys/overlay.ts` (this just describes it). The command tab derives from the
 * one `SLASH_COMMANDS` registry so the two can't drift.
 */
import { SLASH_COMMANDS } from "./slashPalette.js"

export type HelpTab = "commands" | "shortcuts"

export interface HelpState {
  readonly tab: HelpTab
  /** Top row of the windowed body (rows above are scrolled off). */
  readonly scroll: number
}

/** Body rows visible at once (the view windows the flat row list to this). */
export const HELP_VISIBLE = 16

export const openHelp = (): HelpState => ({ tab: "commands", scroll: 0 })

/** One keybind reference line. */
export interface KeyEntry {
  readonly keys: string
  readonly description: string
}

/** A titled group of keybinds. */
export interface KeyGroup {
  readonly title: string
  readonly entries: ReadonlyArray<KeyEntry>
}

/**
 * Every keybind, grouped by where it applies. Mirrors the dispatch in
 * `keys/dispatch.ts` + the per-pane rows in `view/chrome/Keybinds.tsx`.
 */
export const KEYBINDINGS: ReadonlyArray<KeyGroup> = [
  {
    title: "global / navigation",
    entries: [
      { keys: "Ctrl-h/j/k/l · Ctrl-←↑↓→", description: "Move focus between panes" },
      { keys: "w", description: "Cycle to the next pane" },
      { keys: "esc", description: "Return to pane navigation / dismiss" },
      { keys: "i", description: "Focus the input (INSERT)" },
      { keys: "v", description: "Cycle side views (activity → context → agents → sessions)" },
      { keys: ":", description: "Open the command palette" },
      { keys: "/", description: "Search the focused read-only pane" },
      { keys: "z", description: "Zoom the focused pane" },
      { keys: "?", description: "Open this help" },
      { keys: "Ctrl-C", description: "Quit (press twice)" },
    ],
  },
  {
    title: "conversation pane",
    entries: [
      { keys: "j/k · ↑/↓", description: "Scroll lines" },
      { keys: "Ctrl-D/U · PgUp/PgDn", description: "Page up / down" },
      { keys: "{ }", description: "Previous / next paragraph" },
      { keys: "[ ]", description: "Previous / next message" },
      { keys: "gg / G", description: "Jump to top / bottom" },
      { keys: "⇥ / ↵ / h / l", description: "Fold the unit under the cursor" },
      { keys: "Z", description: "Fold all turns" },
      { keys: "n / N", description: "Next / previous search match" },
      { keys: "y", description: "Yank the mouse selection (OSC 52)" },
    ],
  },
  {
    title: "side panes (activity / context / agents / sessions)",
    entries: [
      { keys: "j/k · { }", description: "Move the cursor" },
      { keys: "[ ]", description: "Jump between heads / roots" },
      { keys: "gg / G", description: "Jump to ends" },
      { keys: "⇥ / ↵ / h / l", description: "Fold the unit under the cursor" },
    ],
  },
  {
    title: "context viewer",
    entries: [
      { keys: "Space", description: "Select / deselect a turn or handoff" },
      { keys: "b", description: "Build a new session from the selection" },
    ],
  },
  {
    title: "agents tree",
    entries: [
      { keys: "↵", description: "Open / preview a node" },
      { keys: "c", description: "Fork a node into a new session" },
      { keys: "d", description: "Drop a node + its descendants" },
    ],
  },
  {
    title: "sessions",
    entries: [
      { keys: "↵", description: "Switch the active session" },
      { keys: "F2 / r", description: "Rename the conversation" },
    ],
  },
  {
    title: "input",
    entries: [
      { keys: "↵ · Alt-↵", description: "Send the message" },
      { keys: "⇧↵ · Ctrl-J", description: "Insert a newline" },
      { keys: "↑ / ↓", description: "Recall sent history / move palette highlight" },
      { keys: "⇥ / →", description: "Complete the highlighted command" },
      { keys: "esc", description: "Return to pane navigation" },
    ],
  },
]

/** A flattened body row — `head` titles a group, `entry` is one line. */
export type HelpRow =
  | { readonly kind: "head"; readonly text: string }
  | { readonly kind: "entry"; readonly keys: string; readonly description: string }

/** The active tab's body rows, flattened for windowed rendering. */
export const helpRows = (tab: HelpTab): ReadonlyArray<HelpRow> => {
  if (tab === "commands")
    return SLASH_COMMANDS.map((c) => ({ kind: "entry", keys: c.name, description: c.description }))
  const rows: HelpRow[] = []
  for (const g of KEYBINDINGS) {
    rows.push({ kind: "head", text: g.title })
    for (const e of g.entries) rows.push({ kind: "entry", keys: e.keys, description: e.description })
  }
  return rows
}

const TABS: ReadonlyArray<HelpTab> = ["commands", "shortcuts"]

/** Cycle tabs (resets scroll — a new tab starts at the top). */
export const cycleHelpTab = (state: HelpState, dir: "left" | "right"): HelpState => {
  const i = TABS.indexOf(state.tab)
  const n = TABS.length
  const next = dir === "left" ? (i - 1 + n) % n : (i + 1) % n
  return { tab: TABS[next]!, scroll: 0 }
}

/** Scroll the body one row, clamped to the active tab's row count. */
export const scrollHelp = (state: HelpState, dir: "up" | "down"): HelpState => {
  const total = helpRows(state.tab).length
  const max = Math.max(0, total - HELP_VISIBLE)
  const scroll =
    dir === "up" ? Math.max(0, state.scroll - 1) : Math.min(max, state.scroll + 1)
  return { ...state, scroll }
}
