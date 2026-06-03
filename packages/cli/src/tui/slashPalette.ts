import { ansi, padRight, truncate } from "./terminal.js"

export interface SlashCommand {
  readonly name: string
  readonly description: string
}

// Commands use a `:` prefix (vim ex-style); `/` is reserved for search.
export const SLASH_COMMANDS: ReadonlyArray<SlashCommand> = [
  { name: ":exit", description: "Quit the agent" },
  { name: ":quit", description: "Quit the agent" },
  { name: ":clear", description: "Clear the scrollback" },
  { name: ":help", description: "Show keybindings and commands" },
  { name: ":cwd", description: "Print the current workspace directory" },
  { name: ":reset", description: "Start a new conversation (forgets history)" },
  { name: ":settings", description: "Open the settings modal (arrow + ↵ to edit)" },
  { name: ":set", description: "Update a config setting, e.g. :set maxSteps 30" },
  { name: ":model", description: "Open the model picker (↑↓/filter/↵), or :model <id> to switch" },
  { name: ":search", description: "Open the web search model picker, or :search openai:gpt-4o / default" },
  { name: ":effort", description: "Open the thinking/reasoning effort picker, or :effort <level>" },
  { name: ":login", description: "Add a provider — subscription (OAuth) or API key" },
  { name: ":logout", description: "Remove a provider's credential: :logout <provider>" },
  { name: ":db", description: "Show or set the store: :db pg <url> / :db sqlite [path] [global]" },
  { name: ":handoff", description: "Summarize & hand off — replace loaded history, keep originals" },
  { name: ":context", description: "Toggle the context viewer (turn tree — Space select, b build)" },
  { name: ":build", description: "Build a new session from the turns selected in :context" },
  { name: ":browse", description: "List conversations in this workspace" },
  { name: ":resume", description: "Resume a conversation, e.g. :resume 2" },
]

export interface PaletteState {
  readonly visible: boolean
  readonly matches: ReadonlyArray<SlashCommand>
  readonly selected: number
}

export const hiddenPalette: PaletteState = {
  visible: false,
  matches: [],
  selected: 0,
}

export const computePalette = (input: string): PaletteState => {
  const trimmed = input.trim()
  if (trimmed.startsWith(":") && !trimmed.includes(" ") && !trimmed.includes("\n")) {
    const q = trimmed.toLowerCase()
    const matches = SLASH_COMMANDS.filter((c) => c.name.startsWith(q))
    return {
      visible: matches.length > 0,
      matches,
      selected: 0,
    }
  }
  return hiddenPalette
}

export const movePalette = (
  state: PaletteState,
  dir: "up" | "down",
): PaletteState => {
  if (!state.visible || state.matches.length === 0) return state
  const n = state.matches.length
  const next =
    dir === "up"
      ? (state.selected - 1 + n) % n
      : (state.selected + 1) % n
  return { ...state, selected: next }
}

export const selectedCommand = (
  state: PaletteState,
): SlashCommand | undefined => {
  if (!state.visible) return undefined
  return state.matches[state.selected]
}

/**
 * Render palette rows. Returns at most `maxRows` lines, exactly `cols`
 * wide. Caller positions these directly above the input area.
 *
 * When there are more matches than `maxRows`, the rendered slice is a
 * **window that follows the selection** (so arrowing past the bottom scrolls
 * instead of losing the highlight), with `↑`/`↓` glyphs on the edge rows when
 * more commands sit above/below the window.
 */
export const renderPalette = (
  state: PaletteState,
  cols: number,
  maxRows: number,
): string[] => {
  if (!state.visible) return []
  const n = state.matches.length
  const count = Math.min(maxRows, n)

  // Window start: keep `selected` roughly centred, clamped to a valid range.
  let start = state.selected - Math.floor(count / 2)
  start = Math.max(0, Math.min(start, n - count))

  const moreAbove = start > 0
  const moreBelow = start + count < n

  return state.matches.slice(start, start + count).map((c, j) => {
    const idx = start + j
    const marker =
      idx === state.selected
        ? `${ansi.fgBrightCyan}▸${ansi.reset}`
        : j === 0 && moreAbove
          ? `${ansi.dim}↑${ansi.reset}`
          : j === count - 1 && moreBelow
            ? `${ansi.dim}↓${ansi.reset}`
            : " "
    const name = `${ansi.bold}${c.name}${ansi.reset}`
    const desc = `${ansi.fgGray}${c.description}${ansi.reset}`
    const line = `${marker} ${padRight(name, 14)} ${desc}`
    return truncate(padRight(line, cols), cols)
  })
}
