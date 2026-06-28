/**
 * The keybind reference, as pure data — the single source for the `?` shortcuts
 * overlay (and printed nowhere else now that the persistent keybind box is
 * retired, agy-style). Grouped by concern; the view renders it as one aligned
 * table. Keys lead with the encodings that survive every terminal (Esc, w, :,
 * /); the Ctrl forms are alternatives, not the headline.
 */
export interface ShortcutRow {
  readonly keys: string
  readonly label: string
}

export interface ShortcutGroup {
  readonly title: string
  readonly rows: ReadonlyArray<ShortcutRow>
}

export const SHORTCUT_GROUPS: ReadonlyArray<ShortcutGroup> = [
  {
    title: "focus",
    rows: [
      { keys: "⇥", label: "cycle input → chat → tree" },
      { keys: "^h / ^k", label: "the chat" },
      { keys: "^l", label: "the fleet tree" },
      { keys: "^j", label: "the composer" },
      { keys: "w", label: "cycle focus (NORMAL alias)" },
      { keys: "header", label: "shows [INSERT] / [NOR] / [VIS] mode" },
    ],
  },
  {
    title: "input",
    rows: [
      { keys: "↵", label: "send" },
      { keys: "⇧↵ / ^J", label: "newline" },
      { keys: "↑ / ↓", label: "history · queued · palette" },
      { keys: ":", label: "command menu" },
      { keys: "/", label: "search the focused pane" },
      { keys: "esc", label: "leave the composer" },
    ],
  },
  {
    title: "chat",
    rows: [
      { keys: "j/k · ↑↓", label: "scroll a line" },
      { keys: "^d / ^u", label: "half page" },
      { keys: "{ } / [ ]", label: "paragraph / message" },
      { keys: "gg / G", label: "top / bottom" },
      { keys: "↵ / h l", label: "fold the unit" },
      { keys: "Z", label: "fold all" },
      { keys: "y", label: "yank the selection" },
    ],
  },
  {
    title: "fleet tree",
    rows: [
      { keys: "j/k · { } [ ]", label: "move the cursor" },
      { keys: "h l / ← →", label: "fold a node" },
      { keys: "↵", label: "jump the chat into a node (root row → back)" },
      { keys: "c", label: "fork a node into a new session" },
      { keys: "d", label: "drop a node" },
    ],
  },
  {
    title: "global",
    rows: [
      { keys: "^C ×2", label: "quit" },
      { keys: "esc", label: "interrupt · cancel · close · clear" },
      { keys: "?", label: "this help" },
    ],
  },
]

/**
 * Render the groups as one aligned, multi-line string (a SINGLE `<text>` — the
 * Yoga-safe pattern; sibling `<text>` in a flex row interleaves glyphs across
 * rows at narrow widths). Keys pad to one column so the labels line up.
 */
export const shortcutsTable = (): string => {
  const keyW = Math.max(
    ...SHORTCUT_GROUPS.flatMap((g) => g.rows.map((r) => r.keys.length)),
  )
  const blocks = SHORTCUT_GROUPS.map((g) => {
    const head = g.title
    const rows = g.rows.map((r) => `  ${r.keys.padEnd(keyW)}   ${r.label}`)
    return [head, ...rows].join("\n")
  })
  return blocks.join("\n\n")
}
