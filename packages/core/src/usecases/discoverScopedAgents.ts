import { basename, dirname, isAbsolute, resolve } from "node:path"
import { Effect } from "effect"
import type { ScopedAgentConfig } from "../entities/ScopedAgent.js"
import { FileSystem } from "../ports/FileSystem.js"

/**
 * Discover scoped agents by globbing `**​/SCOPE.md` under the workspace.
 *
 * Each `SCOPE.md`:
 *   - frontmatter: `name` (slug) and `description` (one-liner). Required.
 *   - body: package-specific instructions, injected into the sub-agent's
 *     system prompt under `## Scope-specific instructions`.
 *   - location: the containing directory is the writeable scope (`rootDir`).
 *
 * Missing-frontmatter / unreadable files are silently skipped — a
 * malformed SCOPE.md never breaks the agent. Names are deduped (first
 * encountered wins).
 *
 * Returns `[]` when no `SCOPE.md` files exist; the coder agent then
 * runs without any delegation tools.
 */
export const discoverScopedAgents = (
  workspaceRoot: string,
  now: Date = new Date(),
): Effect.Effect<ReadonlyArray<ScopedAgentConfig>, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    // Recursive list with EACCES-safe walk in the adapter. Filter for
    // files literally named `SCOPE.md`. (Chose `list` over `glob`
    // because Bun.Glob's iterator can't recover from EACCES on a single
    // subdirectory like a root-owned docker `pg-data/`.)
    const entries = yield* fs
      .list(workspaceRoot, { recursive: true })
      .pipe(
        Effect.catchAll(() =>
          Effect.succeed([] as ReadonlyArray<{
            path: string
            type: "file" | "dir"
          }>),
        ),
      )
    const matches = entries
      .filter((e) => e.type === "file" && basename(e.path) === "SCOPE.md")
      .map((e) => e.path)

    const seen = new Set<string>()
    const out: ScopedAgentConfig[] = []
    for (const rel of matches) {
      const abs = isAbsolute(rel) ? rel : resolve(workspaceRoot, rel)
      const read = yield* fs
        .read(abs)
        .pipe(Effect.catchAll(() => Effect.succeed(undefined)))
      if (read === undefined) continue
      const parsed = parseScopeFile(read.content)
      if (parsed === undefined) continue
      if (seen.has(parsed.name)) continue
      seen.add(parsed.name)

      const rootDir = dirname(abs)
      const systemPrompt = renderScopedSystemPrompt({
        name: parsed.name,
        rootDir,
        displayRoot: workspaceRoot,
        scopeBody: parsed.body,
        now,
      })

      out.push({
        name: parsed.name,
        description: parsed.description,
        rootDir,
        displayRoot: workspaceRoot,
        systemPrompt,
      })
    }

    out.sort((a, b) => a.name.localeCompare(b.name))
    return out
  })

interface ParsedScope {
  readonly name: string
  readonly description: string
  /** Body with frontmatter stripped. */
  readonly body: string
}

/**
 * Same frontmatter conventions as skills (see `loadSkills.ts`): a
 * `---\n…\n---` fence at the top, key: value lines inside. Required
 * keys: `name`, `description`. Missing keys → `undefined`.
 */
const parseScopeFile = (content: string): ParsedScope | undefined => {
  if (!content.startsWith("---")) return undefined
  const rest = content.slice(3)
  const lfIndex = rest.indexOf("\n")
  if (lfIndex === -1) return undefined
  const afterFirstFence = rest.slice(lfIndex + 1)
  const closeIndex = afterFirstFence.indexOf("\n---")
  if (closeIndex === -1) return undefined
  const frontmatter = afterFirstFence.slice(0, closeIndex)
  const body = afterFirstFence.slice(closeIndex + 4).replace(/^\n+/, "")

  const fields: Record<string, string> = {}
  for (const line of frontmatter.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    const colon = trimmed.indexOf(":")
    if (colon === -1) continue
    const key = trimmed.slice(0, colon).trim()
    const value = trimmed.slice(colon + 1).trim().replace(/^["']|["']$/g, "")
    fields[key] = value
  }
  const name = fields["name"]
  const description = fields["description"]
  if (name === undefined || description === undefined) return undefined
  return { name, description, body }
}

interface RenderScopedSystemPromptArgs {
  readonly name: string
  readonly rootDir: string
  readonly displayRoot: string
  readonly scopeBody: string
  readonly now: Date
}

/**
 * Standard scoped-agent header + the SCOPE.md body verbatim. The header
 * explains scope semantics (read-anywhere, write-in-scope, no bash) and
 * the return contract; the body is the user's package-specific bit.
 */
const renderScopedSystemPrompt = (args: RenderScopedSystemPromptArgs): string =>
  `You are the **${args.name}** sub-agent, invoked by a parent coder agent on a focused task.

# Scope
- Workspace root: ${args.displayRoot}
- Your scope: ${args.rootDir}
- date: ${args.now.toISOString().slice(0, 10)}

You can **read anywhere** in the workspace using read_file/grep/glob/ls — useful for learning types and conventions from files outside your scope.

You can **only write inside your scope**. write_file or edit_file on a path outside ${args.rootDir} returns a structured tool error '{ ok: false, error: "OutOfScope", ... }'. Treat that as a constraint, not a bug: if the work requires writing outside, say so in your final summary and let the parent decide.

You have **no bash tool**. If the task needs tests, builds, or shell commands to run, mention that in your final summary; the parent will handle it.

# Tools
- read_file({ path, offset?, limit? }) — read anywhere.
- write_file({ path, content }) — write only within your scope.
- edit_file({ path, edits: [{ oldText, newText }] }) — edit only within your scope.
- grep({ pattern, dir?, flags?, context? }) — search anywhere.
- glob({ pattern, dir? }) — find files anywhere.
- ls({ path?, recursive? }) — list anywhere.

# Doing tasks
- Use tools to read; do not answer from memory.
- Read before you write. Make minimal, targeted edits — prefer edit_file over write_file for existing files.
- Keep changes tightly scoped to the task. Don't add speculative abstractions, compatibility shims, or unrelated cleanup. Don't create files unless the task requires it.
- If an approach fails, diagnose before switching tactics. Don't repeat a failing call with the same args.
- Tool failures are data: state what happened in one line, adjust, continue. An OutOfScope error means you need to defer that part to the parent — keep going on what you can do.
- Report outcomes faithfully. If you couldn't verify the change (no bash means no typecheck), say so in your summary so the parent knows to run it.
- Show paths exactly as they are (relative to the workspace root).

# Return contract
Your final assistant message is a **one-line summary** of what you changed (or why you couldn't). The parent reads this; brevity matters. Files you actually wrote will be tracked separately and shown to the parent — you do NOT need to list them.

## Scope-specific instructions

${args.scopeBody}`
