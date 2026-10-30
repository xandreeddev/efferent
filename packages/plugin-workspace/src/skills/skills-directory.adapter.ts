import { basename, resolve } from "node:path"
import { Effect, Layer, Option } from "effect"
import { Capabilities, collectSkillFiles, definePlugin, FileSystem, HarnessError, readSkillFiles, SessionEnvironment } from "@xandreed/core"
import type { SkillDefinition } from "@xandreed/core"
import { SkillsDirectoryConfig, skillsDirectoryDefaults } from "./skills-directory.entity.js"
import type { SkillRoot } from "./skills-directory.entity.js"
import { mergeSkillRoots, settleSkills, skillsCapability } from "./skills-directory.entity.functions.js"

const rootFailure = (message: string) => new HarnessError({ code: "skills.root", message })

/**
 * One root, read: none when it is missing and not `required`. A root that
 * cannot be listed (a file, no permission) or a file in it that cannot be
 * read fails with `skills.root`; a root over `maxFiles` or `maxBytes` with
 * `skills.limit`. Binary files and files over `maxReferenceBytes` do not
 * count toward `maxBytes`.
 */
const readRoot = (root: string, config: SkillsDirectoryConfig): Effect.Effect<Option.Option<SkillRoot>, HarnessError, FileSystem> => Effect.gen(function* () {
  const fs = yield* FileSystem
  const present = yield* fs.exists(root)
  if (!present) {
    if (config.required) return yield* Effect.fail(rootFailure(`the skills root ${root} does not exist (required)`))
    yield* Effect.logDebug(`skills: no directory at ${root}; skipped`)
    return Option.none()
  }
  // A file over maxReferenceBytes is never served, so it is not read either (nor counted toward maxBytes).
  const files = yield* collectSkillFiles(root, { maxFiles: config.maxFiles, maxBytes: config.maxBytes, maxFileBytes: config.maxReferenceBytes })
  const tree = readSkillFiles(files, { tools: config.tools, maxReferenceBytes: config.maxReferenceBytes, rootName: basename(root) })
  return Option.some({ root, tree })
}).pipe(Effect.catchTag("FsError", (error) => Effect.fail(rootFailure(`cannot read the skills root ${root}: ${error.path}: ${error.message}`))))

/**
 * The skills in `config.roots`, each resolved against `workspace` (an
 * absolute directory) unless absolute, read through the `FileSystem` port:
 * the ids prefixed, the first root winning a clash, issues failing
 * (`strict`) or logged, and the limits checked. What `skillsDirectoryPlugin`
 * contributes; a host that composes capabilities itself can call it.
 *
 * @public
 */
export const loadSkillsDirectory = (config: SkillsDirectoryConfig, workspace: string): Effect.Effect<ReadonlyArray<SkillDefinition>, HarnessError, FileSystem> =>
  Effect.forEach(config.roots, (root) => readRoot(resolve(workspace, root), config), { concurrency: 1 }).pipe(
    Effect.map((roots) => mergeSkillRoots(roots.flatMap(Option.toArray), config.idPrefix)),
    Effect.flatMap((found) => settleSkills(found, config)),
  )

/**
 * Skills from directories of `SKILL.md` files (the Agent Skills layout,
 * `.agents/skills/<name>/SKILL.md` by default), read once per agent through
 * the `FileSystem` port and contributed as one capability. Tool discovery
 * lists them in its catalogue, `load_skill` returns a skill's instructions
 * and `read_skill_reference` the other files of its directory. A skill id
 * the host or another plugin also defines fails `Agent.define` with
 * `skills.duplicate`: set `idPrefix`. Relative roots resolve against the
 * agent's workspace (`SessionEnvironment`), else the process's working
 * directory.
 */
export const skillsDirectoryPlugin = definePlugin({
  id: "@xandreed/plugin-workspace/skills", version: "0.14.0", scope: "runtime",
  config: SkillsDirectoryConfig, defaults: skillsDirectoryDefaults,
  requires: [FileSystem],
  optional: [SessionEnvironment],
  provides: [],
  contributes: [Capabilities],
  layer: (config) => Layer.effect(Capabilities, Effect.gen(function* () {
    const environment = yield* Effect.serviceOption(SessionEnvironment)
    const workspace = resolve(Option.match(environment, { onNone: () => ".", onSome: (found) => found.workspace }))
    const skills = yield* loadSkillsDirectory(config, workspace)
    return [skillsCapability(skills, config)]
  })),
})
/**
 * The skills directory as a typed layer: contributes `Capabilities`; requires `FileSystem` (and reads `SessionEnvironment` when present).
 *
 * @public
 */
export const SkillsDirectoryPluginLive = skillsDirectoryPlugin.live
