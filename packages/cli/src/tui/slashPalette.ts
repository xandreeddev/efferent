import { ansi, padRight, truncate } from "./terminal.js"

export interface SlashCommand {
  readonly name: string
  readonly description: string
}

export const SLASH_COMMANDS: ReadonlyArray<SlashCommand> = [
  { name: "/exit", description: "Quit the agent" },
  { name: "/quit", description: "Quit the agent" },
  { name: "/clear", description: "Clear the scrollback" },
  { name: "/help", description: "Show keybindings and commands" },
  { name: "/cwd", description: "Print the current workspace directory" },
  { name: "/reset", description: "Start a new conversation (forgets history)" },
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
  if (trimmed.startsWith("/") && !trimmed.includes(" ") && !trimmed.includes("\n")) {
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
 */
export const renderPalette = (
  state: PaletteState,
  cols: number,
  maxRows: number,
): string[] => {
  if (!state.visible) return []
  const rows = state.matches.slice(0, maxRows).map((c, i) => {
    const marker = i === state.selected ? `${ansi.fgBrightCyan}▸${ansi.reset}` : " "
    const name = `${ansi.bold}${c.name}${ansi.reset}`
    const desc = `${ansi.fgGray}${c.description}${ansi.reset}`
    const line = `${marker} ${padRight(name, 14)} ${desc}`
    return truncate(padRight(line, cols), cols)
  })
  return rows
}
