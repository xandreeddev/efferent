import { Option } from "effect"
import type { Effect } from "effect"
import type { AgentDefinition } from "../entities/AgentDefinition.js"
import type { FileSystem } from "../ports/FileSystem.js"
import { parseFrontmatter } from "./parseFrontmatter.js"
import { loadMarkdownAssets, workspaceSearchPath } from "./workspaceDiscovery.js"

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
  loadMarkdownAssets({
    dirs: workspaceSearchPath(cwd, homeDir, ".efferent/agents"),
    logTag: "agent",
    name: (agent) => agent.name,
    parse: parseAgentFile,
  })

/**
 * Parse one agent `.md`. Required: `name`, `description`. Optional: `role`
 * (`general` | `code` — the model TIER; any other value is ignored, defaulting
 * to general) and `tools` (a comma/space-separated allowlist — the flat parser
 * has no array support, so we split the value). A `model:` field is
 * intentionally NOT read — a definition picks a role, never a specific model, so
 * the human owns which models back each role. Returns `None` when the fence
 * is missing or required keys are absent.
 *
 * Exported so the git-import path can validate a downloaded file before
 * writing it to disk.
 */
export const parseAgentFile = (
  content: string,
  sourcePath: string,
): Option.Option<AgentDefinition> => {
  const fm = parseFrontmatter(content)
  if (fm === undefined) return Option.none()
  const name = fm.fields["name"]
  const description = fm.fields["description"]
  if (name === undefined || description === undefined) return Option.none()
  const roleRaw = fm.fields["role"]?.trim().toLowerCase()
  const role = roleRaw === "general" || roleRaw === "code" ? roleRaw : undefined
  const toolsRaw = fm.fields["tools"]
  const tools =
    toolsRaw !== undefined
      ? toolsRaw.split(/[,\s]+/).filter((t) => t.length > 0)
      : undefined
  return Option.some({
    name,
    description,
    ...(role !== undefined ? { role } : {}),
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    body: fm.body,
    sourcePath,
  })
}
