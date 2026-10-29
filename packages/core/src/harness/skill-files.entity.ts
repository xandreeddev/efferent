import { Schema } from "effect"
import { SkillDefinition } from "./capability.entity.js"

/**
 * One file of a skills tree, as read: its path relative to the tree's root
 * (POSIX, `/`-separated: `SKILL.md`, `git/SKILL.md`,
 * `git/references/style.md`) and its text. `size` is set only for a file
 * that was not read because it is too large (`collectSkillFiles`'
 * `maxFileBytes`): its size in bytes, with an empty `text`;
 * `readSkillFiles` leaves such a file out with a warning.
 */
export const SkillFile = Schema.Struct({
  path: Schema.String,
  text: Schema.String,
  size: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
})
export type SkillFile = typeof SkillFile.Type

/**
 * Something met while reading a skills tree, at a path relative to its root.
 * An `error` leaves the skill out (its `SKILL.md` has no frontmatter or no
 * description, its id is taken); a `warning` leaves out part of a skill (a
 * reference over the size limit, or one whose path is not a valid id) or a
 * value it could not read.
 */
export const SkillFileIssue = Schema.Struct({
  path: Schema.String,
  severity: Schema.Literals(["error", "warning"]),
  message: Schema.String,
})
export type SkillFileIssue = typeof SkillFileIssue.Type

/** One skill of a tree: the directory its `SKILL.md` is in, relative to the tree's root (`""` for the root itself), and the skill. */
export const SkillTreeEntry = Schema.Struct({
  directory: Schema.String,
  skill: SkillDefinition,
})
export type SkillTreeEntry = typeof SkillTreeEntry.Type

/** A directory tree of skills as read: every skill that loaded, by the path of its `SKILL.md`, and the issues met. */
export const SkillTree = Schema.Struct({
  skills: Schema.Array(SkillTreeEntry),
  issues: Schema.Array(SkillFileIssue),
})
export type SkillTree = typeof SkillTree.Type

/**
 * How `readSkillFiles` reads a tree. `tools`: `"declared"` (the default)
 * keeps each skill's `tools` field, `"ignore"` drops it, so loading a skill
 * from the tree activates no tool. `maxReferenceBytes`: a reference larger
 * than this (UTF-8 bytes) is left out with a warning; no limit when absent.
 * `rootName`: the id of a `SKILL.md` at the tree's root that names none; a
 * root `SKILL.md` without an id is an error when absent.
 */
export const SkillFilesOptions = Schema.Struct({
  tools: Schema.optionalKey(Schema.Literals(["declared", "ignore"])),
  maxReferenceBytes: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  rootName: Schema.optionalKey(Schema.String),
})
export type SkillFilesOptions = typeof SkillFilesOptions.Type

/**
 * How much of a directory `collectSkillFiles` reads: at most `maxFiles`
 * files and `maxBytes` bytes of text, or it fails with `skills.limit`.
 * `maxFileBytes`: a file other than a `SKILL.md` larger than this is not
 * read and does not count toward `maxBytes`; it is collected with its
 * `size` (give `readSkillFiles` the same `maxReferenceBytes`). No limit when
 * absent.
 */
export const CollectSkillFilesOptions = Schema.Struct({
  maxFiles: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  maxBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  maxFileBytes: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
})
export type CollectSkillFilesOptions = typeof CollectSkillFilesOptions.Type
