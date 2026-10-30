import { Schema } from "effect"
import { SkillDefinition, SkillFileIssue, SkillTree } from "@xandreed/core"

/** One root as read: its absolute path and the tree of skills in it. */
export const SkillRoot = Schema.Struct({
  root: Schema.String,
  tree: SkillTree,
})
export type SkillRoot = typeof SkillRoot.Type

/** The skills of every root together, and every issue, its path absolute. */
export const SkillsFound = Schema.Struct({
  skills: Schema.Array(SkillDefinition),
  issues: Schema.Array(SkillFileIssue),
})
export type SkillsFound = typeof SkillsFound.Type

const count = (maximum: number) => Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum })))

/**
 * How `skillsDirectoryPlugin` loads skills from directories of `SKILL.md`
 * files. Flat.
 *
 * - `roots`: the directories, absolute or relative to the agent's workspace
 *   (`SessionEnvironment`, else the process's working directory). A skill
 *   whose id an earlier root already loaded is left out (an issue). One
 *   instance with several roots is how to read several directories: the
 *   capability and section ids are fixed, so two instances would share them.
 * - `required`: a missing root fails `Agent.define` (`skills.root`); when
 *   false, a missing root is skipped.
 * - `strict`: any issue (a `SKILL.md` without frontmatter or description, an
 *   id taken, a reference over `maxReferenceBytes`, an unreadable value)
 *   fails `Agent.define` with `skills.files`; when false, each is logged as a
 *   warning and what it names is left out.
 * - `tools`: `"ignore"` drops the `tools` each `SKILL.md` declares, so a file
 *   skill is instructions and references only; `"declared"` keeps them, and
 *   a tool no capability registers fails `Agent.define` with `skills.tools`.
 * - `idPrefix`: put before every skill id (`"project."`), for skills whose
 *   ids clash with the host's or another plugin's (`skills.duplicate`).
 * - `maxReferenceBytes`: a reference larger than this is left out (it is
 *   not read, and does not count toward `maxBytes`).
 * - `maxSkills` (all roots together), `maxFiles` and `maxBytes` (each root's
 *   files, and bytes of text): more fails `Agent.define` with `skills.limit`.
 * - `alwaysSection`: render the instructions of the skills marked `always`
 *   in a static system-prompt section (tool discovery activates always-on
 *   skills but never shows their instructions), at `sectionOrder`.
 *
 * @public
 */
export const SkillsDirectoryConfig = Schema.Struct({
  roots: Schema.Array(Schema.NonEmptyString),
  required: Schema.Boolean,
  strict: Schema.Boolean,
  tools: Schema.Literals(["declared", "ignore"]),
  idPrefix: Schema.String.check(Schema.isPattern(/^\S*$/)).annotate({ description: "Put before every skill id; no whitespace." }),
  maxReferenceBytes: count(16_777_216),
  maxSkills: count(10_000),
  maxFiles: count(1_000_000),
  maxBytes: count(1_073_741_824),
  alwaysSection: Schema.Boolean,
  sectionOrder: Schema.Int,
})
export type SkillsDirectoryConfig = typeof SkillsDirectoryConfig.Type

/** @public */
export const skillsDirectoryDefaults: SkillsDirectoryConfig = {
  roots: [".agents/skills"],
  required: false,
  strict: false,
  tools: "ignore",
  idPrefix: "",
  maxReferenceBytes: 65_536,
  maxSkills: 200,
  maxFiles: 2_000,
  maxBytes: 8_388_608,
  alwaysSection: true,
  sectionOrder: 850,
}
