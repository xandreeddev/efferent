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
