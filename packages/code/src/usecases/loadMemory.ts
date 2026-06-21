import { basename, dirname, isAbsolute, resolve } from "node:path"
import { Effect } from "effect"
import { FileSystem, type Memory } from "@xandreed/sdk-core"
import { parseFrontmatter } from "./discoverScopeTree.js"

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
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const seen = new Set<string>()
    const memory: Memory[] = []

    for (const dir of memorySearchPath(cwd, homeDir)) {
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
        const parsed = parseMemoryFile(read.content, absPath)
        if (parsed === undefined) continue
        if (seen.has(parsed.name)) continue
        seen.add(parsed.name)
        memory.push(parsed)
      }
    }

    memory.sort((a, b) => a.name.localeCompare(b.name))
    return memory
  })

/**
 * Search path: cwd/.efferent/memory, then each ancestor up to root, then
 * homeDir/.efferent/memory (deduped). Order matters — earlier entries win.
 */
const memorySearchPath = (cwd: string, homeDir: string): ReadonlyArray<string> => {
  const out: string[] = []
  const seen = new Set<string>()
  let dir = cwd
  while (true) {
    const candidate = resolve(dir, ".efferent/memory")
    if (!seen.has(candidate)) {
      out.push(candidate)
      seen.add(candidate)
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const homeCandidate = resolve(homeDir, ".efferent/memory")
  if (!seen.has(homeCandidate)) out.push(homeCandidate)
  return out
}

/**
 * Parse one memory `.md`. Unlike a skill, ALL frontmatter is optional: `name`
 * is the filename slug, `title` falls back to the slug, `summary` to empty. So
 * a frontmatter-less file is still a valid memory (the `remember` tool writes
 * frontmatter, but a hand-authored note needn't). The body is lazy-loaded by
 * `read_memory`, so only the metadata is kept here.
 */
const parseMemoryFile = (
  content: string,
  sourcePath: string,
): Memory | undefined => {
  const name = basename(sourcePath).replace(/\.md$/, "")
  if (name.length === 0) return undefined
  const fm = parseFrontmatter(content)
  const title = fm?.fields["title"] ?? name
  const summary = fm?.fields["summary"] ?? ""
  return { name, title, summary, sourcePath }
}
