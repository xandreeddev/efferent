import { dirname, isAbsolute, resolve } from "node:path"
import { Effect } from "effect"
import { type AgentDefinition, FileSystem, parseFrontmatter } from "@xandreed/sdk-core"

/**
 * Walk `cwd → parents → home` looking for `.efferent/agents/*.md` files,
 * parse their frontmatter into {@link AgentDefinition}s, dedupe by `name`
 * (first occurrence wins — closer-to-cwd shadows farther-from-cwd).
 *
 * Failures (missing dirs, unreadable files, malformed frontmatter) are
 * silently skipped so a bad agent file never breaks the agent. Mirrors
 * `loadSkills` exactly.
 */
export const loadAgents = (
  cwd: string,
  homeDir: string,
): Effect.Effect<ReadonlyArray<AgentDefinition>, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const seen = new Set<string>()
    const agents: AgentDefinition[] = []

    for (const dir of agentSearchPath(cwd, homeDir)) {
      const entries = yield* fs
        .list(dir, { recursive: false })
        .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<{
          path: string
          type: "file" | "dir"
        }>)))

      for (const entry of entries) {
        if (entry.type !== "file" || !entry.path.endsWith(".md")) continue
        const absPath = isAbsolute(entry.path)
          ? entry.path
          : resolve(dir, entry.path)
        const read = yield* fs
          .read(absPath)
          .pipe(Effect.catchAll(() => Effect.succeed(undefined)))
        if (read === undefined) continue
        const parsed = parseAgentFile(read.content, absPath)
        if (parsed === undefined) continue
        if (seen.has(parsed.name)) continue
        seen.add(parsed.name)
        agents.push(parsed)
      }
    }

    agents.sort((a, b) => a.name.localeCompare(b.name))
    return agents
  })

/**
 * Search path: cwd/.efferent/agents, then each ancestor up to root, then
 * homeDir/.efferent/agents (deduped). Order matters — earlier entries win.
 */
const agentSearchPath = (cwd: string, homeDir: string): ReadonlyArray<string> => {
  const out: string[] = []
  const seen = new Set<string>()
  let dir = cwd
  while (true) {
    const candidate = resolve(dir, ".efferent/agents")
    if (!seen.has(candidate)) {
      out.push(candidate)
      seen.add(candidate)
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const homeCandidate = resolve(homeDir, ".efferent/agents")
  if (!seen.has(homeCandidate)) out.push(homeCandidate)
  return out
}

/**
 * Parse one agent `.md`. Required: `name`, `description`. Optional: `role`
 * (`general` | `code` — the model TIER; any other value is ignored, defaulting
 * to general) and `tools` (a comma/space-separated allowlist — the flat parser
 * has no array support, so we split the value). A `model:` field is
 * intentionally NOT read — a definition picks a role, never a specific model, so
 * the human owns which models back each role. Returns `undefined` when the fence
 * is missing or required keys are absent.
 *
 * Exported so the git-import path can validate a downloaded file before
 * writing it to disk.
 */
export const parseAgentFile = (
  content: string,
  sourcePath: string,
): AgentDefinition | undefined => {
  const fm = parseFrontmatter(content)
  if (fm === undefined) return undefined
  const name = fm.fields["name"]
  const description = fm.fields["description"]
  if (name === undefined || description === undefined) return undefined
  const roleRaw = fm.fields["role"]?.trim().toLowerCase()
  const role = roleRaw === "general" || roleRaw === "code" ? roleRaw : undefined
  const toolsRaw = fm.fields["tools"]
  const tools =
    toolsRaw !== undefined
      ? toolsRaw.split(/[,\s]+/).filter((t) => t.length > 0)
      : undefined
  return {
    name,
    description,
    ...(role !== undefined ? { role } : {}),
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    body: fm.body,
    sourcePath,
  }
}
