import { Schema } from "effect"
import { CommitSha } from "./pull-request.entity.js"

/**
 * Where a repository declares which of its skills bear on which files (`SkillRoutes`), read at the base commit as the
 * instruction files are, so a pull request cannot change what it is reviewed by.
 */
export const REVIEW_SKILLS_FILE = ".agents/review-skills.json"

/** The most characters of skills a group's message holds: whole skills while they fit, then a skill's ranked sections. */
export const SKILLS_SHOWN = 30_000

/** The least room left worth a skill's sections; with less, the skills after it are left out. */
export const SKILL_ROOM_LEAST = 1_500

/** The room kept back from a skill's sections for its first line, the headings left out and `SECTIONS_NOTE`. */
export const SKILL_HEADINGS_ROOM = 400

/**
 * One skill and the files it bears on: its file (`path`, from the root), the globs of the paths that call for it
 * (`paths`, as `listFiles` matches them), and words whose presence in a group's diff calls for it wherever the file
 * lives (`diff`, plain text, never a pattern: a declaration such as `Schema.Struct` or an import of a package). A group
 * gets every skill one of its paths or its diff calls for, in the order the routes are declared.
 */
export const SkillRoute = Schema.Struct({
  path: Schema.Trimmed.check(Schema.isNonEmpty()),
  paths: Schema.Array(Schema.Trimmed.check(Schema.isNonEmpty())),
  diff: Schema.Array(Schema.String.check(Schema.isNonEmpty())),
})
export type SkillRoute = typeof SkillRoute.Type

/** A repository's skill routes, as `REVIEW_SKILLS_FILE` holds them: `{ "skills": [ … ] }`, in the order they apply. */
export const SkillRoutes = Schema.Struct({ skills: Schema.Array(SkillRoute) })
export type SkillRoutes = typeof SkillRoutes.Type

/**
 * Where a review's skills come from: none (`Off`, the default until an evaluation shows them worth their room), the
 * repository's own routes at the base commit (`Repo`, `REVIEW_SKILLS_FILE`), or routes the host gives (`Given`, the
 * skills' texts still read at the base commit), for a repository that declares none, or an evaluation at a commit
 * before it did.
 */
export const SkillsSource = Schema.Union([
  Schema.TaggedStruct("Off", {}),
  Schema.TaggedStruct("Repo", {}),
  Schema.TaggedStruct("Given", { routes: SkillRoutes }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type SkillsSource = typeof SkillsSource.Type

/** A routed skill as read at the base commit (`from`): its route and its text. */
export const RepoSkill = Schema.Struct({
  route: SkillRoute,
  text: Schema.String,
  from: CommitSha,
})
export type RepoSkill = typeof RepoSkill.Type

/** The skills a group's message shows: the paths of those shown (whole or by sections), and the text, empty for none. */
export const ShownSkills = Schema.Struct({
  paths: Schema.Array(Schema.String),
  text: Schema.String,
})
export type ShownSkills = typeof ShownSkills.Type

/** No skill shown: a group's message as it was before skills, its turn's tail `FOCUS_TAIL`. */
export const NO_SKILLS: ShownSkills = { paths: [], text: "" }

/** The words after a skill shown by its sections: the others are named by their headings only. */
export const SECTIONS_NOTE = "Only the sections that bear on the files under review are shown whole; the others by their headings."

/** Path parts too common to rank a skill's sections by. */
export const TERMS_LEFT_OUT: ReadonlyArray<string> = ["src", "packages", "lib", "index", "test", "tests", "the", "ts", "tsx", "js", "md"]
