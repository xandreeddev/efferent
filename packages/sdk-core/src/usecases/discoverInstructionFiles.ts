import { basename, dirname, resolve } from "node:path"
import { Array as Arr, Effect, Option } from "effect"
import { FileSystem } from "../ports/FileSystem.js"
import { ancestorDirs } from "./workspaceDiscovery.js"

/**
 * A markdown instruction file picked up from the ancestor chain.
 * `path` is absolute; `content` is the verbatim file body (un-truncated;
 * the renderer applies the prompt budget).
 *
 * `kind` distinguishes hand-written guidance (`agent` — `AGENT.md`) from the
 * **curated constraints** the human keeps
 * (`constraints` — `.efferent/CONSTRAINTS.md`). Both are always-on hard rules,
 * but constraints render under their own prominent `# Constraints` heading so
 * the model reads the loop's learned rules as a first-class layer. See
 * `docs/self-improving-loop.md`.
 */
export interface InstructionFile {
  readonly path: string
  readonly content: string
  readonly kind?: "agent" | "constraints" | "operating"
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
    const candidates = instructionSearchPath(cwd, homeDir).flatMap((dir) =>
      INSTRUCTION_FILE_NAMES.map(({ kind, name }) => ({ abs: resolve(dir, name), kind })),
    )
    const reads = yield* Effect.forEach(candidates, ({ abs, kind }) =>
      fs.read(abs).pipe(
        Effect.map((read) =>
          read.content.trim() === ""
            ? Option.none<FoundInstructionFile>()
            : Option.some({
                path: abs,
                content: read.content,
                kind,
                normalized: normalizeContent(read.content),
              }),
        ),
        Effect.catchAll(() => Effect.succeed(Option.none<FoundInstructionFile>())),
      ),
    )
    const found = Arr.getSomes(reads)
    const deduped = found.filter(
      (file, index) => found.findIndex((f) => f.normalized === file.normalized) === index,
    )
    return deduped.map(({ content, kind, path }) => ({ path, content, kind }))
  })

interface FoundInstructionFile {
  readonly path: string
  readonly content: string
  readonly kind: "agent" | "constraints" | "operating"
  readonly normalized: string
}

/**
 * The files discovered per ancestor dir. `AGENT.md` is hand-written guidance;
 * `.efferent/CONSTRAINTS.md` is the workspace's curated hard-rules
 * file (`docs/self-improving-loop.md`) — same always-on-hard-rule semantics, but
 * rendered under its own `# Constraints` heading.
 */
const INSTRUCTION_FILE_NAMES = [
  { name: "AGENT.md", kind: "agent" },
  { name: "AGENT.local.md", kind: "agent" },
  { name: ".efferent/CONSTRAINTS.md", kind: "constraints" },
  // The loop-editable + hand-editable operating-guidance overlay (Phase 2: the
  // self-improving loop's meta/process learnings — "plan first", "check
  // assumptions" — land here as Opus-validated bullets, scope-routed global/local).
  { name: ".efferent/prompts/coder.md", kind: "operating" },
] as const

/**
 * Order: root → … → cwd → homeDir. The model reads broad guidance
 * first and narrows in. (Matches claw-code's reversed walk.)
 */
const instructionSearchPath = (cwd: string, homeDir: string): ReadonlyArray<string> => {
  const chain = Arr.reverse(ancestorDirs(cwd))
  return chain.includes(homeDir) ? chain : [...chain, homeDir]
}

/**
 * Stable normalization for dedupe: collapse runs of blank lines, trim
 * trailing whitespace per line, trim the whole string. No content hash
 * needed — JS Sets compare strings in O(n) of the key length, which is
 * fine for ≤ a few thousand chars × a small ancestor chain.
 */
const normalizeContent = (content: string): string => {
  const lines = content.split("\n").map((line) => line.trimEnd())
  return lines
    .filter((line, index) => !(line === "" && lines[index - 1] === ""))
    .join("\n")
    .trim()
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

  const operatingFiles = files.filter((f) => f.kind === "operating")
  const constraintFiles = files.filter((f) => f.kind === "constraints")
  const agentFiles = files.filter(
    (f) => f.kind !== "constraints" && f.kind !== "operating",
  )

  // Operating guidance renders FIRST — it shapes HOW you work (planning,
  // assumptions, delegation), above the hard rules below. It's the loop's
  // Opus-validated meta-learnings + any hand-written .efferent/prompts/coder.md.
  const operating = renderFileGroup(
    operatingFiles,
    "# Operating guidance",
    "How to approach work in this workspace — operating guidance (planning, assumptions, delegation discipline) the self-improving loop learned and Opus-validated, plus any hand-written `.efferent/prompts/coder.md`. Internalize it before you start; it shapes HOW you work, above the domain rules below.",
  )
  // Constraints render under their own heading — the loop's learned hard rules,
  // a high-priority always-on layer (see `docs/self-improving-loop.md`).
  const constraints = renderFileGroup(
    constraintFiles,
    "# Constraints",
    "Hard rules this workspace keeps to stop known mistakes from recurring — follow them unless the user explicitly overrides one in conversation.",
  )
  const instructions = renderFileGroup(
    agentFiles,
    "# Instructions",
    "Auto-discovered AGENT.md files from the workspace's ancestor chain. Treat them as durable guidance for this workspace — hard rules unless the user explicitly overrides them in conversation.",
  )
  const body = [operating, constraints, instructions]
    .filter((s) => s.length > 0)
    .join("\n\n")
  if (body === "") return ""
  return `\n${body}\n`
}

interface RenderFold {
  readonly remaining: number
  readonly sections: ReadonlyArray<string>
  readonly omitted: boolean
}

/** Render one labelled group of instruction files under `heading`, honoring the
 *  shared per-file + total char budgets. Returns "" when the group is empty. */
const renderFileGroup = (
  files: ReadonlyArray<InstructionFile>,
  heading: string,
  preamble: string,
): string => {
  if (files.length === 0) return ""
  const folded = Arr.reduce(
    files,
    { remaining: MAX_TOTAL_INSTRUCTION_CHARS, sections: [heading, preamble], omitted: false } as RenderFold,
    (acc, file) => {
      if (acc.omitted) return acc
      if (acc.remaining <= 0) {
        return {
          ...acc,
          omitted: true,
          sections: [
            ...acc.sections,
            "_Additional content omitted after reaching the prompt budget._",
          ],
        }
      }
      const cap = Math.min(MAX_INSTRUCTION_FILE_CHARS, acc.remaining)
      const trimmed = file.content.trim()
      const rendered =
        trimmed.length <= cap ? trimmed : `${trimmed.slice(0, cap)}\n\n[truncated]`
      return {
        remaining: acc.remaining - rendered.length,
        omitted: false,
        sections: [
          ...acc.sections,
          `## ${basename(file.path)} (scope: ${dirname(file.path)})`,
          rendered,
        ],
      }
    },
  )
  return folded.sections.join("\n\n")
}
