import { dirname, isAbsolute, resolve } from "node:path"
import { Effect } from "effect"
import { FileSystem, parseFrontmatter, type Skill } from "@xandreed/sdk-core"

/**
 * Walk `cwd → parents → home` looking for `.efferent/skills/*.md` files,
 * parse their frontmatter, dedupe by `name` (first occurrence wins —
 * closer-to-cwd shadows farther-from-cwd).
 *
 * Failures (missing dirs, unreadable files, malformed frontmatter) are
 * silently skipped so a bad skill never breaks the agent.
 */
export const loadSkills = (
  cwd: string,
  homeDir: string,
): Effect.Effect<ReadonlyArray<Skill>, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const seen = new Set<string>()
    const skills: Skill[] = []

    for (const dir of skillSearchPath(cwd, homeDir)) {
      const entries = yield* fs
        .list(dir, { recursive: false })
        .pipe(Effect.catchAll((e) => Effect.log(`skills: skipping ${dir}: ${e}`).pipe(Effect.zipRight(Effect.succeed([] as ReadonlyArray<{
          path: string
          type: "file" | "dir"
        }>)))))

      for (const entry of entries) {
        if (entry.type !== "file" || !entry.path.endsWith(".md")) continue
        const absPath = isAbsolute(entry.path)
          ? entry.path
          : resolve(dir, entry.path)
        const read = yield* fs
          .read(absPath)
          .pipe(Effect.catchAll((e) => Effect.log(`skills: skipping ${absPath}: ${e}`).pipe(Effect.zipRight(Effect.succeed(undefined)))))
        if (read === undefined) continue
        const parsed = parseSkillFile(read.content, absPath)
        if (parsed === undefined) continue
        if (seen.has(parsed.name)) continue
        seen.add(parsed.name)
        skills.push(parsed)
      }
    }

    skills.sort((a, b) => a.name.localeCompare(b.name))
    return skills
  })

/**
 * Search path: cwd/.efferent/skills, then each ancestor up to root, then
 * homeDir/.efferent/skills (deduped). Order matters — earlier entries win.
 */
const skillSearchPath = (cwd: string, homeDir: string): ReadonlyArray<string> => {
  const out: string[] = []
  const seen = new Set<string>()
  let dir = cwd
  while (true) {
    const candidate = resolve(dir, ".efferent/skills")
    if (!seen.has(candidate)) {
      out.push(candidate)
      seen.add(candidate)
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const homeCandidate = resolve(homeDir, ".efferent/skills")
  if (!seen.has(homeCandidate)) out.push(homeCandidate)
  return out
}

/**
 * Parse one skill `.md` via the shared {@link parseFrontmatter}. Required
 * keys: `name`, `description`. The body is read lazily by `read_skill`, so
 * only the metadata is kept here.
 */
const parseSkillFile = (
  content: string,
  sourcePath: string,
): Skill | undefined => {
  const fm = parseFrontmatter(content)
  if (fm === undefined) return undefined
  const name = fm.fields["name"]
  const description = fm.fields["description"]
  if (name === undefined || description === undefined) return undefined
  return { name, description, sourcePath }
}
