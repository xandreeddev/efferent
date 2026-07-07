import { basename } from "node:path"
import { Option } from "effect"
import type { Effect } from "effect"
import type { Memory } from "../entities/Memory.js"
import type { FileSystem } from "../ports/FileSystem.js"
import { parseFrontmatter } from "./parseFrontmatter.js"
import { loadMarkdownAssets, workspaceSearchPath } from "./workspaceDiscovery.js"

/**
 * Walk `cwd → parents → home` looking for `.efferent/memory/*.md` files (the
 * durable, agent-maintained knowledge layer), parse their frontmatter, dedupe
 * by `name` (first occurrence wins — closer-to-cwd shadows farther-from-cwd).
 *
 * `name` is the filename slug; `title`/`summary` come from optional frontmatter
 * (title falls back to the slug, summary to empty). The body is read lazily by
 * `read_memory`, so only the index metadata is kept here.
 *
 * Failures (missing dirs, unreadable files, malformed frontmatter) are silently
 * skipped so a bad memory file never breaks the agent — mirrors `loadSkills`.
 */
export const loadMemory = (
  cwd: string,
  homeDir: string,
): Effect.Effect<ReadonlyArray<Memory>, never, FileSystem> =>
  loadMarkdownAssets({
    dirs: workspaceSearchPath(cwd, homeDir, ".efferent/memory"),
    logTag: "memory",
    name: (memory) => memory.name,
    parse: parseMemoryFile,
  })

/**
 * Parse one memory `.md`. Unlike a skill, ALL frontmatter is optional: `name`
 * is the filename slug, `title` falls back to the slug, `summary` to empty. So
 * a frontmatter-less file is still a valid memory (the `remember` tool writes
 * frontmatter, but a hand-authored note needn't). The body is lazy-loaded by
 * `read_memory`, so only the metadata is kept here.
 */
const parseMemoryFile = (content: string, sourcePath: string): Option.Option<Memory> => {
  const name = basename(sourcePath).replace(/\.md$/, "")
  if (name.length === 0) return Option.none()
  const fm = parseFrontmatter(content)
  return Option.some({
    name,
    title: fm?.fields["title"] ?? name,
    summary: fm?.fields["summary"] ?? "",
    sourcePath,
  })
}
