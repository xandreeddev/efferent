import { Option } from "effect"

/**
 * The live `:` command palette — matches render as you type (the old line's
 * slashPalette UX, streamlined). Pure: the composer text in, the visible
 * rows out. `resolveCommand` also gives the executor unique-prefix matching
 * (`:mo` runs `:model`), so what the palette shows is what Enter runs.
 */

export interface PaletteCommand {
  readonly name: string
  readonly usage: string
  readonly desc: string
}

export const PALETTE_COMMANDS: ReadonlyArray<PaletteCommand> = [
  { name: "quit", usage: ":quit", desc: "leave the session (Ctrl-C works too)" },
  { name: "new", usage: ":new", desc: "drop the current draft — back to the dashboard" },
  { name: "lock", usage: ":lock", desc: "approve the draft; only a locked spec forges" },
  { name: "forge", usage: ":forge [slug]", desc: "build the locked draft (or a named spec)" },
  { name: "ship", usage: ":ship", desc: "branch, commit, push + PR the last ACCEPTED run" },
  { name: "model", usage: ":model [code|fast] [p:m]", desc: "switch a model role (picker or direct)" },
  { name: "resume", usage: ":resume [id]", desc: "load a previous session into this one" },
  { name: "login", usage: ":login", desc: "set up providers — API keys / anthropic OAuth" },
  { name: "logout", usage: ":logout [provider]", desc: "remove a provider credential" },
]

export const PALETTE_VISIBLE = 9

/** The rows to show for the current composer text; empty = no palette. */
export const computePalette = (input: string): ReadonlyArray<PaletteCommand> => {
  if (!input.startsWith(":")) return []
  const token = input.slice(1).split(/\s+/)[0] ?? ""
  // Once a full command + space is typed, the palette collapses to that
  // command's row (a usage reminder), not the whole list.
  const matches = PALETTE_COMMANDS.filter((c) => c.name.startsWith(token.toLowerCase()))
  return matches.slice(0, PALETTE_VISIBLE)
}

/** Unique-prefix resolution: `:mo` → `model`; ambiguous/unknown → None. */
export const resolveCommand = (word: string): Option.Option<string> => {
  const token = word.toLowerCase()
  if (token.length === 0) return Option.none()
  const exact = PALETTE_COMMANDS.find((c) => c.name === token)
  if (exact !== undefined) return Option.some(exact.name)
  const prefixed = PALETTE_COMMANDS.filter((c) => c.name.startsWith(token))
  return prefixed.length === 1
    ? Option.map(Option.fromNullable(prefixed[0]), (c) => c.name)
    : Option.none()
}

/** The longest string every name shares as a prefix (the shell-tab-complete
 *  common-stem). Empty when the set disagrees at char 0. */
const commonPrefix = (names: ReadonlyArray<string>): string =>
  names.reduce(
    (stem, name) => {
      const bound = Math.min(stem.length, name.length)
      const cut = Array.from({ length: bound }).findIndex((_, i) => stem[i] !== name[i])
      return cut === -1 ? stem.slice(0, bound) : stem.slice(0, cut)
    },
    names[0] ?? "",
  )

/**
 * Tab-completion for the `:` composer — the completed line, or `None` when
 * there is nothing to add. Only the FIRST token completes (a command with an
 * argument is already chosen). A unique match fills the whole command and a
 * trailing space (ready for its argument); several matches extend to their
 * shared stem (`:l` → `:lo`); a line already sitting on the branch point
 * (`:lo` → lock/login/logout) returns `None` — the palette shows the fork.
 */
export const completeCommand = (input: string): Option.Option<string> => {
  if (!input.startsWith(":")) return Option.none()
  const rest = input.slice(1)
  // A space means the command is committed; completion is the arg's job, not ours.
  if (/\s/.test(rest) || rest.length === 0) return Option.none()
  const token = rest.toLowerCase()
  const matches = PALETTE_COMMANDS.filter((c) => c.name.startsWith(token))
  if (matches.length === 0) return Option.none()
  if (matches.length === 1) return Option.some(`:${matches[0]?.name} `)
  const stem = commonPrefix(matches.map((c) => c.name))
  return stem.length > token.length ? Option.some(`:${stem}`) : Option.none()
}
