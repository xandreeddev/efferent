import { join } from "node:path"
import { Effect, Option } from "effect"
import { FileSystem } from "@xandreed/engine"

/**
 * Agent SKILLS — progressive disclosure, file-based and workspace-local
 * (`.efferent/skills/<name>.md`). Deliberately NOT a plugin system: a skill
 * is instructions, never code — no registry, no network, no execution. The
 * agent sees only name+description at boot (tier 1), pulls the full body
 * with `load_skill` when the task matches (tier 2), and reaches referenced
 * files through the ordinary read tools (tier 3). Dozens of capabilities,
 * token cost only for the one in use.
 */

export const SKILLS_DIR = ".efferent/skills"
/** Skills SHIPPED with smith (mechanism know-how — e.g. how to author a
 *  gate rule). Merged into discovery beneath the workspace's own skills:
 *  a workspace file with the same name WINS. */
export const BUNDLED_SKILLS_DIR = join(import.meta.dir, "..", "..", "skills")
const MAX_SKILLS = 20
const BODY_CAP_CHARS = 12_000
const DESCRIPTION_CAP_CHARS = 200
/** Skill names are file stems — never paths. */
const SKILL_NAME = /^[a-z0-9][a-z0-9-_]*$/i

export interface SkillMeta {
  readonly name: string
  readonly description: string
}

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`

/** `---\nkey: value\n---\nbody` — minimal, forgiving; None when the file has
 *  no description (an undocumented skill can't be surfaced meaningfully). */
const parseSkill = (
  stem: string,
  text: string,
): Option.Option<{ readonly meta: SkillMeta; readonly body: string }> => {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.trim())
  if (match === null) return Option.none()
  const fields = new Map(
    (match[1] ?? "")
      .split("\n")
      .flatMap((line) => {
        const at = line.indexOf(":")
        return at > 0 ? [[line.slice(0, at).trim(), line.slice(at + 1).trim()] as const] : []
      }),
  )
  const description = fields.get("description") ?? ""
  if (description.length === 0) return Option.none()
  const name = fields.get("name") ?? stem
  if (!SKILL_NAME.test(name)) return Option.none()
  return Option.some({
    meta: { name, description: clip(description, DESCRIPTION_CAP_CHARS) },
    body: (match[2] ?? "").trim(),
  })
}

const discoverDir = (
  dir: string,
): Effect.Effect<ReadonlyArray<SkillMeta>, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const entries = yield* fs
      .list(dir)
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
    const parsed = yield* Effect.forEach(
      entries.filter((entry) => entry.endsWith(".md")).slice(0, MAX_SKILLS),
      (entry) =>
        fs.read(join(dir, entry)).pipe(
          Effect.map((text) =>
            Option.toArray(
              Option.map(parseSkill(entry.replace(/\.md$/, ""), text), (skill) => skill.meta),
            ),
          ),
          Effect.orElseSucceed(() => [] as ReadonlyArray<SkillMeta>),
        ),
    )
    return parsed.flat()
  })

/** Tier 1: every valid skill's metadata (bounded; unreadable/invalid files
 *  skip — a broken skill must not brick the run). Workspace skills first,
 *  then bundled ones the workspace doesn't shadow by name. */
export const discoverSkills = (
  cwd: string,
): Effect.Effect<ReadonlyArray<SkillMeta>, never, FileSystem> =>
  Effect.gen(function* () {
    const workspace = yield* discoverDir(join(cwd, SKILLS_DIR))
    const bundled = yield* discoverDir(BUNDLED_SKILLS_DIR)
    const names = new Set(workspace.map((skill) => skill.name))
    return [...workspace, ...bundled.filter((skill) => !names.has(skill.name))].slice(
      0,
      MAX_SKILLS,
    )
  })

/** The system-prompt block — names + descriptions only (tier 1). */
export const renderSkillsBlock = (skills: ReadonlyArray<SkillMeta>): string =>
  skills.length === 0
    ? ""
    : [
        "## Skills available (workspace-provided procedures — call load_skill BEFORE doing work one covers)",
        ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
      ].join("\n")

/** Tier 2: one skill's full instructions — the workspace's file when it
 *  exists, else the bundled one. `None` = unknown/invalid name. */
export const readSkill = (
  cwd: string,
  name: string,
): Effect.Effect<Option.Option<string>, never, FileSystem> =>
  Effect.gen(function* () {
    if (!SKILL_NAME.test(name)) return Option.none<string>()
    const fs = yield* FileSystem
    const readFrom = (dir: string): Effect.Effect<Option.Option<string>, never, never> =>
      fs.read(join(dir, `${name}.md`)).pipe(
        Effect.map((text) =>
          Option.map(parseSkill(name, text), (skill) => clip(skill.body, BODY_CAP_CHARS)),
        ),
        Effect.orElseSucceed(() => Option.none<string>()),
      )
    const workspace = yield* readFrom(join(cwd, SKILLS_DIR))
    if (Option.isSome(workspace)) return workspace
    return yield* readFrom(BUNDLED_SKILLS_DIR)
  })
