import { Effect, Option } from "effect"
import { canonicalJson, defineCapability, definePromptSection, fingerprintOf, HarnessError, SkillId, skillIssuesText } from "@xandreed/core"
import type { Capability, SkillDefinition, SkillFileIssue } from "@xandreed/core"
import type { SkillRoot, SkillsDirectoryConfig, SkillsFound } from "./skills-directory.entity.js"

/**
 * The id of the capability the skills are contributed in. It is fixed, as
 * is `ALWAYS_SECTION_ID`: read several directories with one plugin instance
 * and several `roots`. Two instances would contribute two capabilities, and
 * two sections, with the same id in `context.built` and turn records.
 */
export const SKILLS_CAPABILITY_ID = "@xandreed/plugin-workspace/skills"
/** The static section with the always-on skills' instructions. */
export const ALWAYS_SECTION_ID = "workspace.skills.always"

const inRoot = (root: string, path: string): string => root.endsWith("/") ? `${root}${path}` : `${root}/${path}`
const skillFileOf = (root: string, directory: string): string => inRoot(root, directory === "" ? "SKILL.md" : `${directory}/SKILL.md`)

interface Merged {
  readonly skills: ReadonlyArray<{ readonly skill: SkillDefinition; readonly from: string }>
  readonly issues: ReadonlyArray<SkillFileIssue>
}

/**
 * Every root's skills together, in root order: each id with `idPrefix`
 * before it, a skill whose id an earlier root (or an earlier skill) already
 * loaded left out with an error, and every issue's path made absolute.
 */
export const mergeSkillRoots = (roots: ReadonlyArray<SkillRoot>, idPrefix: string): SkillsFound => {
  const merged = roots.reduce<Merged>((sofar, { root, tree }) => tree.skills.reduce<Merged>((state, entry) => {
    const skill = { ...entry.skill, id: SkillId.make(`${idPrefix}${entry.skill.id}`) }
    const from = skillFileOf(root, entry.directory)
    const taken = state.skills.find((other) => other.skill.id === skill.id)
    return taken === undefined
      ? { ...state, skills: [...state.skills, { skill, from }] }
      : { ...state, issues: [...state.issues, { path: from, severity: "error", message: `the skill id ${skill.id} is already loaded from ${taken.from}` }] }
  }, { ...sofar, issues: [...sofar.issues, ...tree.issues.map((found) => ({ ...found, path: inRoot(root, found.path) }))] }), { skills: [], issues: [] })
  return { skills: merged.skills.map((item) => item.skill), issues: merged.issues }
}

/**
 * The skills to contribute: with `strict`, any issue fails with
 * `skills.files` naming each one; otherwise each is logged as a warning.
 * More than `maxSkills` fails with `skills.limit`.
 */
export const settleSkills = Effect.fn("skills.settle")(function* (found: SkillsFound, config: Pick<SkillsDirectoryConfig, "strict" | "maxSkills">): Effect.fn.Return<ReadonlyArray<SkillDefinition>, HarnessError> {
  if (config.strict && found.issues.length > 0) {
    return yield* Effect.fail(new HarnessError({ code: "skills.files", message: skillIssuesText(found.issues) }))
  }
  yield* Effect.forEach(found.issues, (issue) => Effect.logWarning(`skills: ${issue.path}: ${issue.message} (${issue.severity === "error" ? "skill left out" : "read without it"})`), { concurrency: 1, discard: true })
  if (found.skills.length > config.maxSkills) {
    return yield* Effect.fail(new HarnessError({ code: "skills.limit", message: `found ${found.skills.length} skills, more than ${config.maxSkills} (maxSkills)` }))
  }
  return found.skills
})

/**
 * The always-on skills' instructions as one system-prompt section: tool
 * discovery activates them at every turn's start but lists only the skills
 * that are loaded on demand.
 */
export const alwaysSkillsText = (skills: ReadonlyArray<SkillDefinition>): Option.Option<string> => {
  const always = skills.filter((skill) => skill.always)
  return always.length === 0 ? Option.none() : Option.some([
    "## Always-on skills",
    ...always.map((skill) => [
      `### ${skill.id}`,
      skill.instructions.length > 0 ? skill.instructions : skill.summary,
      skill.references.length === 0 ? "" : `References (read_skill_reference): ${skill.references.map((reference) => `${reference.id} — ${reference.title}`).join("; ")}`,
    ].filter((line) => line.length > 0).join("\n")),
  ].join("\n\n"))
}

/** The skills as one capability, with the always-on section when `alwaysSection` is set and some skill is always on. */
export const skillsCapability = (skills: ReadonlyArray<SkillDefinition>, config: Pick<SkillsDirectoryConfig, "alwaysSection" | "sectionOrder">): Capability => {
  // The text is the skills', made here: the section reads no service when it renders.
  const section = Option.filter(alwaysSkillsText(skills), () => config.alwaysSection).pipe(Option.map((text) => definePromptSection({
    id: ALWAYS_SECTION_ID, version: fingerprintOf(text), tier: "static", order: config.sectionOrder, render: () => Effect.succeed(Option.some(text)),
  })))
  return defineCapability({
    id: SKILLS_CAPABILITY_ID,
    version: fingerprintOf(canonicalJson(skills.map((skill) => [skill.id, skill.version]))),
    skills,
    promptSections: Option.toArray(section),
  })
}
