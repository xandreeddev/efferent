import { Schema } from "effect"
import type { Toolkit } from "effect/ai"

/**
 * A skill's name: lower-case words joined by hyphens (`unit-converter`), at most 64 characters. The model writes
 * it to load the skill, and a journal keeps it, so it is a word a host does not change.
 *
 * @public
 */
export const SkillId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/), Schema.isMaxLength(64)).pipe(Schema.brand("SkillId"))
export type SkillId = typeof SkillId.Type

/**
 * The name of the tool that loads a skill.
 *
 * @public
 */
export const LOAD_SKILL = "loadSkill"

/**
 * What `loadSkill` answers: the skill it loaded and that skill's instructions, as the host wrote them. It is the
 * call's stored result, so it is what `loadedOf` reads from a journal: a skill is loaded where such a result is
 * stored, and nowhere else.
 *
 * @public
 */
export const LoadedSkill = Schema.Struct({ skill: SkillId, instructions: Schema.String })
export type LoadedSkill = typeof LoadedSkill.Type

/**
 * Instructions and tools a host has, which the model is not sent until it asks (ADR 0013). `summary` is the skill's
 * line in the catalogue the model always reads; `instructions` reach it as the result of the `loadSkill` call that
 * loads the skill; `tools` is the toolkit of the skill's own tools, offered once it is loaded (`Toolkit.empty` for
 * a skill that is instructions alone). `defineSkill` makes one.
 *
 * @public
 */
export interface Skill<Kit extends Toolkit.Any = Toolkit.Any> {
  readonly id: SkillId
  readonly summary: string
  readonly instructions: string
  readonly tools: Kit
}

/**
 * What `defineSkill` is given: a skill with its name as the host writes it.
 *
 * @public
 */
export interface SkillOptions<Kit extends Toolkit.Any> {
  readonly id: string
  readonly summary: string
  readonly instructions: string
  readonly tools: Kit
}

/** The most characters of a skill's summary: it is one line of a text sent with every request. */
export const SUMMARY_LIMIT = 200
