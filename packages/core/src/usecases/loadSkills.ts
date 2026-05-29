import { dirname, isAbsolute, resolve } from "node:path"
import { Effect } from "effect"
import type { Skill } from "../entities/Skill.js"
import { FileSystem } from "../ports/FileSystem.js"

/**
 * Walk `cwd → parents → home` looking for `.agent/skills/*.md` files,
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
 * Search path: cwd/.agent/skills, then each ancestor up to root, then
 * homeDir/.agent/skills (deduped). Order matters — earlier entries win.
 */
const skillSearchPath = (cwd: string, homeDir: string): ReadonlyArray<string> => {
  const out: string[] = []
  const seen = new Set<string>()
  let dir = cwd
  while (true) {
    const candidate = resolve(dir, ".agent/skills")
    if (!seen.has(candidate)) {
      out.push(candidate)
      seen.add(candidate)
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const homeCandidate = resolve(homeDir, ".agent/skills")
  if (!seen.has(homeCandidate)) out.push(homeCandidate)
  return out
}

/**
 * Minimal frontmatter parser. Expects:
 *
 *   ---
 *   name: <slug>
 *   description: <one line>
 *   ---
 *   (body)
 *
 * Returns `undefined` if frontmatter is missing or required keys are
 * absent. Values are taken verbatim, trimmed; no nested YAML, no arrays,
 * no multi-line values.
 */
const parseSkillFile = (
  content: string,
  sourcePath: string,
): Skill | undefined => {
  if (!content.startsWith("---")) return undefined
  const rest = content.slice(3)
  const lfIndex = rest.indexOf("\n")
  if (lfIndex === -1) return undefined
  const afterFirstFence = rest.slice(lfIndex + 1)
  const closeIndex = afterFirstFence.indexOf("\n---")
  if (closeIndex === -1) return undefined
  const frontmatter = afterFirstFence.slice(0, closeIndex)
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
  return { name, description, sourcePath }
}
