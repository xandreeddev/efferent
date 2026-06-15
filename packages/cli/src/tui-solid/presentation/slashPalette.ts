export interface SlashCommand {
  readonly name: string
  readonly description: string
}

/** Max command rows shown (and navigable) in the palette — the view slices to
 *  this and the keymap wraps the highlight within it, so they can't drift. */
export const PALETTE_VISIBLE = 6

// Commands use a `:` prefix (vim ex-style); `/` is reserved for search.
export const SLASH_COMMANDS: ReadonlyArray<SlashCommand> = [
  { name: ":exit", description: "Quit the agent" },
  { name: ":quit", description: "Quit the agent" },
  { name: ":clear", description: "Start a new conversation (new id, empty scrollback)" },
  { name: ":cwd", description: "Print the current workspace directory" },
  { name: ":settings", description: "Open the settings modal (arrow + ↵ to edit)" },
  { name: ":set", description: "Update a config setting, e.g. :set maxSteps 30" },
  { name: ":model", description: "Open the model picker (↑↓/filter/↵), or :model <id> to switch" },
  { name: ":search", description: "Open the web search model picker, or :search openai:gpt-4o / default" },
  { name: ":effort", description: "Open the thinking/reasoning effort picker, or :effort <level>" },
  { name: ":theme", description: "Switch the colour theme (↑↓/↵), or :theme <name>" },
  { name: ":login", description: "Add a provider — subscription (OAuth) or API key" },
  { name: ":logout", description: "Remove a provider's credential: :logout <provider>" },
  { name: ":db", description: "Show or set the store: :db pg <url> / :db sqlite [path] [global]" },
  { name: ":handoff", description: "Summarize & hand off — replace loaded history, keep originals" },
  { name: ":context", description: "Toggle the context viewer (turn tree — Space select, b build)" },
  { name: ":tree", description: "Toggle the agent tree (this session's sub-agents: ↵ open · c fork · d drop)" },
  { name: ":sessions", description: "Toggle the workspace sessions list (↵ switches the active session)" },
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
