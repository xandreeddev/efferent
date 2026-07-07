import { Option } from "effect"
import type { Effect } from "effect"
import type { Skill } from "../entities/Skill.js"
import type { FileSystem } from "../ports/FileSystem.js"
import { parseFrontmatter } from "./parseFrontmatter.js"
import { loadMarkdownAssets, workspaceSearchPath } from "./workspaceDiscovery.js"

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
  loadMarkdownAssets({
    dirs: workspaceSearchPath(cwd, homeDir, ".efferent/skills"),
    logTag: "skills",
    name: (skill) => skill.name,
    parse: parseSkillFile,
  })

/**
 * Parse one skill `.md` via the shared {@link parseFrontmatter}. Required
 * keys: `name`, `description`. The body is read lazily by `read_skill`, so
 * only the metadata is kept here.
 */
const parseSkillFile = (content: string, sourcePath: string): Option.Option<Skill> =>
  Option.fromNullable(parseFrontmatter(content)).pipe(
    Option.flatMap((fm) =>
      Option.all({
        name: Option.fromNullable(fm.fields["name"]),
        description: Option.fromNullable(fm.fields["description"]),
      }),
    ),
    Option.map(({ description, name }) => ({ name, description, sourcePath })),
  )
