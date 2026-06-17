import { basename, dirname, resolve } from "node:path"
import { Effect } from "effect"
import { FileSystem } from "@efferent/sdk-core"

/**
 * A markdown instruction file picked up from the ancestor chain.
 * `path` is absolute; `content` is the verbatim file body (un-truncated;
 * the renderer applies the prompt budget).
 */
export interface InstructionFile {
  readonly path: string
  readonly content: string
}

/** Per-file char cap in the rendered prompt. Mirrors Claude Code. */
export const MAX_INSTRUCTION_FILE_CHARS = 4_000
/** Total char budget for the whole `# Instructions` section. */
export const MAX_TOTAL_INSTRUCTION_CHARS = 12_000

/**
 * Walk `/` → … → cwd → homeDir looking for `AGENT.md` /
 * `AGENT.local.md`. Returns files in walk order — root-most ancestor
 * first, workspace last, then home — so the rendered prompt reads
 * broad-then-narrow.
 *
 * Dedupes by normalized content (blank-line collapse + trim) so the
 * same body stacked at multiple levels (e.g. user copied AGENT.md from
 * one repo to another) only appears once.
 *
 * Failures (missing files, unreadable, transient errors) are silently
 * skipped — a broken AGENT.md never breaks the agent.
 */
export const discoverInstructionFiles = (
  cwd: string,
  homeDir: string,
): Effect.Effect<ReadonlyArray<InstructionFile>, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const seenContent = new Set<string>()
    const out: InstructionFile[] = []

    for (const dir of instructionSearchPath(cwd, homeDir)) {
      for (const name of INSTRUCTION_FILE_NAMES) {
        const abs = resolve(dir, name)
        const read = yield* fs
          .read(abs)
          .pipe(Effect.catchAll(() => Effect.succeed(undefined)))
        if (read === undefined) continue
        if (read.content.trim() === "") continue
        const normalized = normalizeContent(read.content)
        if (seenContent.has(normalized)) continue
        seenContent.add(normalized)
        out.push({ path: abs, content: read.content })
      }
    }
    return out
  })

const INSTRUCTION_FILE_NAMES = ["AGENT.md", "AGENT.local.md"] as const

/**
 * Order: root → … → cwd → homeDir. The model reads broad guidance
 * first and narrows in. (Matches claw-code's reversed walk.)
 */
const instructionSearchPath = (
  cwd: string,
  homeDir: string,
): ReadonlyArray<string> => {
  const chain: string[] = []
  let dir = cwd
  while (true) {
    chain.push(dir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  chain.reverse()
  if (!chain.includes(homeDir)) chain.push(homeDir)
  return chain
}

/**
 * Stable normalization for dedupe: collapse runs of blank lines, trim
 * trailing whitespace per line, trim the whole string. No content hash
 * needed — JS Sets compare strings in O(n) of the key length, which is
 * fine for ≤ a few thousand chars × a small ancestor chain.
 */
const normalizeContent = (content: string): string => {
  const compact: string[] = []
  let lastBlank = false
  for (const line of content.split("\n")) {
    const trimmed = line.trimEnd()
    const blank = trimmed === ""
    if (blank && lastBlank) continue
    compact.push(trimmed)
    lastBlank = blank
  }
  return compact.join("\n").trim()
}

/**
 * Render the `# Instructions` prompt section from the discovered files.
 * Per-file cap: `MAX_INSTRUCTION_FILE_CHARS`. Total cap:
 * `MAX_TOTAL_INSTRUCTION_CHARS`. Files past the total budget surface a
 * one-line "omitted" notice rather than silently disappearing.
 *
 * Each file is labeled with its basename + the absolute scope directory
 * so the model can tell which guidance applies where (workspace-wide vs.
 * package-local vs. user-global).
 */
export const renderInstructionsSection = (
  files: ReadonlyArray<InstructionFile>,
): string => {
  if (files.length === 0) return ""

  const sections: string[] = [
    "# Instructions",
    "Auto-discovered AGENT.md files from the workspace's ancestor chain. Treat them as durable guidance for this workspace — hard rules unless the user explicitly overrides them in conversation.",
  ]
  let remaining = MAX_TOTAL_INSTRUCTION_CHARS
  for (const file of files) {
    if (remaining <= 0) {
      sections.push(
        "_Additional instruction content omitted after reaching the prompt budget._",
      )
      break
    }
    const cap = Math.min(MAX_INSTRUCTION_FILE_CHARS, remaining)
    const trimmed = file.content.trim()
    const rendered =
      trimmed.length <= cap ? trimmed : `${trimmed.slice(0, cap)}\n\n[truncated]`
    const scope = dirname(file.path)
    sections.push(`## ${basename(file.path)} (scope: ${scope})`)
    sections.push(rendered)
    remaining -= rendered.length
  }
  return `\n${sections.join("\n\n")}\n`
}
