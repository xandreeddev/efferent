import { Option, Predicate, Result, Schema } from "effect"
import { Toolkit } from "effect/ai"
import type { Prompt, Tool } from "effect/ai"
import type { StoredEvent } from "@xandreed/core"
import { hostNote } from "../memory/memory.entity.functions.js"
import { LOAD_SKILL, LoadedSkill, SkillId, SUMMARY_LIMIT } from "./skill.entity.js"
import type { Skill, SkillOptions } from "./skill.entity.js"

const named = Schema.decodeUnknownOption(SkillId)
const loaded = Schema.decodeUnknownOption(LoadedSkill)

/** A text of the model's, or of untyped code, as a message shows it: its start, and how much was left out. */
const shown = (text: unknown): string => {
  const written = typeof text === "string" ? text : String(text)
  if (written.length <= NAME_SHOWN) return JSON.stringify(written)
  const end = (written.charCodeAt(NAME_SHOWN - 1) & 0xfc00) === 0xd800 ? NAME_SHOWN - 1 : NAME_SHOWN
  return `${JSON.stringify(written.slice(0, end))} [… ${written.length - end} characters clipped]`
}

/** The most characters of a name that is no skill's a message repeats. */
const NAME_SHOWN = 64

/**
 * A skill's options as a skill, or what is wrong with them, in words for whoever wrote them. It reads the options
 * as they are, whatever their type says: untyped code writes a skill by hand.
 */
const checked = <Kit extends Toolkit.Any>(options: SkillOptions<Kit>): Result.Result<Skill<Kit>, string> =>
  Option.match(named(options.id), {
    onNone: () => Result.fail(`a skill's id is lower-case words joined by hyphens, at most 64 characters, such as "unit-converter": ${shown(options.id)} is none`),
    onSome: (id) => {
      const summary = typeof options.summary === "string" ? options.summary.trim() : ""
      if (summary.length === 0 || summary.length > SUMMARY_LIMIT || summary.includes("\n")) {
        return Result.fail(`the skill ${id} needs a summary of one line, 1 to ${SUMMARY_LIMIT} characters: it is the skill's line in the catalogue`)
      }
      if (typeof options.instructions !== "string" || options.instructions.trim().length === 0) return Result.fail(`the skill ${id} needs instructions: they are what loading it gives the model`)
      if (!Predicate.hasProperty(options.tools, "tools") || !Predicate.isObject(options.tools.tools)) {
        return Result.fail(`the skill ${id} needs tools, a toolkit: Toolkit.make(…) of its own tools, or Toolkit.empty when it has none`)
      }
      return Result.succeed({ id, summary, instructions: options.instructions, tools: options.tools })
    },
  })

/**
 * A skill (ADR 0013): a name, one line that says when to load it, the instructions loading it gives the model, and
 * the toolkit of its own tools (`Toolkit.empty` when it has none). Options that make no skill are refused here,
 * where they are written: it throws, as a definition does.
 *
 * @public
 */
export const defineSkill = <Kit extends Toolkit.Any>(options: SkillOptions<Kit>): Skill<Kit> =>
  Result.getOrThrowWith(checked(options), (problem) => new Error(problem))

/**
 * The catalogue: what the model reads of the skills before it loads any. A host puts it in its system text. It
 * names every skill and says nothing of which are loaded, so it is the same in every request.
 *
 * @public
 */
export const catalogue = (skills: ReadonlyArray<Skill>): string =>
  [
    `You have skills: instructions and tools you are not given until you load them. Before you do something a skill covers, call ${LOAD_SKILL} with its name and follow what it returns.`,
    ...skills.map((skill) => `- ${skill.id}: ${skill.summary}`),
  ].join("\n")

/**
 * The skills loaded in a journal, in the order they were first loaded, each once: the stored results of
 * `loadSkill` that did not fail. A pure fold: a skill is loaded because that result is stored, so it is loaded
 * after a restart and not in another conversation.
 *
 * @public
 */
export const loadedOf = (journal: ReadonlyArray<StoredEvent>): ReadonlyArray<SkillId> =>
  Array.from(new Set(journal.flatMap((event) => {
    const message = event.message
    if (message === undefined || message._tag !== "ToolResult" || message.name !== LOAD_SKILL || message.isFailure) return []
    return Option.match(loaded(message.result), { onNone: () => [], onSome: (result) => [result.skill] })
  })))

/** The skills whose instructions a context still holds: those a result of `loadSkill` in it names. */
export const instructionsIn = (context: ReadonlyArray<Prompt.MessageEncoded>): ReadonlyArray<SkillId> =>
  context.flatMap((message) => (message.role === "tool" ? message.content : [])).flatMap((part) =>
    part.type === "tool-result" && part.name === LOAD_SKILL && !part.isFailure
      ? Option.match(loaded(part.result), { onNone: () => [], onSome: (result) => [result.skill] })
      : [])

/**
 * What the model is told when skills are loaded and a memory no longer sends their instructions: which they are,
 * and how to read them again. It names the skills and holds none of their text, so it stays short.
 */
export const reloadNote = (skills: ReadonlyArray<SkillId>): string =>
  hostNote(`these skills are loaded, and their instructions are no longer in this conversation: ${skills.join(", ")}. Call ${LOAD_SKILL} again with a skill's name to read its instructions before you use it.`)

/** What `loadSkill` answers when no skill has the name it was given. The name is the model's: a long one is cut, with what was cut counted. */
export const noSkillNamed = (name: string, skills: ReadonlyArray<Skill>): string =>
  `No skill is named ${shown(name)}. The skills are: ${skills.map((skill) => skill.id).join(", ")}.`

/** The names of a toolkit's tools. */
const toolNames = (toolkit: Toolkit.Any): ReadonlyArray<string> => Object.keys(toolkit.tools)

/**
 * What is wrong with a base toolkit and the skills given with it, if anything, in words for whoever wrote them:
 * no skill at all, a skill that is none (one written by hand is checked as `defineSkill` checks its options), two
 * skills with one name, or a tool two of them have (a tool is offered by its name, and it belongs to one skill or
 * to none).
 */
export const skillsProblem = (base: Toolkit.Any, skills: ReadonlyArray<Skill>): Result.Result<void, string> => {
  if (skills.length === 0) return Result.fail("skills needs at least one skill: skills(tools, defineSkill({ … }))")
  if (!Predicate.hasProperty(base, "tools") || !Predicate.isObject(base.tools)) return Result.fail("skills needs the host's toolkit first: skills(tools, …), with Toolkit.empty when it has no tool of its own")
  const unfit = skills.flatMap((skill) => Result.match(Predicate.isObject(skill) ? checked(skill) : Result.fail("a skill is made with defineSkill({ id, summary, instructions, tools })"), { onFailure: (problem) => [problem], onSuccess: () => [] }))[0]
  if (unfit !== undefined) return Result.fail(unfit)
  const twice = skills.find((skill, at) => skills.findIndex((other) => other.id === skill.id) !== at)
  if (twice !== undefined) return Result.fail(`two skills are named ${twice.id}: a skill is loaded by its name`)
  const owners = [
    ...toolNames(base).map((tool) => [tool, "the base toolkit"] as const),
    [LOAD_SKILL, "the kernel"] as const,
    ...skills.flatMap((skill) => toolNames(skill.tools).map((tool) => [tool, `the skill ${skill.id}`] as const)),
  ]
  const shared = owners.find(([tool], at) => owners.findIndex(([other]) => other === tool) !== at)
  if (shared === undefined) return Result.void
  const first = owners.find(([tool]) => tool === shared[0])
  return Result.fail(`the tool ${shared[0]} is in ${first?.[1] ?? "one toolkit"} and in ${shared[1]}: a tool belongs to one skill, or to none`)
}

/**
 * The place a tool is offered at, given the skills loaded: with the tools no skill owns (0), or after them at the
 * place its skill was loaded; none while its skill is not loaded. A loaded name no skill has places nothing.
 */
export const rankOf = (skills: ReadonlyArray<Skill>, loadedSkills: ReadonlyArray<SkillId>) => (tool: string): Option.Option<number> => {
  const owner = skills.find((skill) => Object.hasOwn(skill.tools.tools, tool))
  if (owner === undefined) return Option.some(0)
  const at = loadedSkills.indexOf(owner.id)
  return at === -1 ? Option.none() : Option.some(at + 1)
}

/**
 * The tools of a toolkit that have a place, in the order of their places, as a toolkit: Effect AI's own, made of
 * those tools, so it handles what it holds and fails a call of any other tool as it fails an unknown one. Each tool
 * keeps its own type, so the result is typed as every tool it could hold: what a call of it needs is what any tool
 * of the whole needs, whichever are held now.
 */
export const offeredBy = <Tools extends Record<string, Tool.Any>>(toolkit: Toolkit.Toolkit<Tools>, placeOf: (tool: string) => Option.Option<number>) => {
  const placed: Array<readonly [number, Tools[Extract<keyof Tools, string>]]> = []
  for (const name in toolkit.tools) {
    if (!Object.hasOwn(toolkit.tools, name)) continue
    const place = placeOf(name)
    if (Option.isSome(place)) placed.push([place.value, toolkit.tools[name]])
  }
  return Toolkit.make(...placed.toSorted(([a], [b]) => a - b).map(([, tool]) => tool))
}

/**
 * A toolkit of some of `Tools`, as Effect AI types one made of them: for a toolkit Effect AI made, the same tools
 * as the whole. It is typed as every tool it could hold, so what a call of it needs is what any tool of the whole
 * needs: never `any`, and never less than the tools it holds now.
 *
 * @public
 */
export type Offered<Tools extends Record<string, Tool.Any>> = ReturnType<typeof offeredBy<Tools>>

/** A toolkit typed as any toolkit, which names no tool: itself, or `never` for a toolkit that has its tools' types. */
type Lost<Kit> = Kit extends Toolkit.Toolkit<infer _Tools> ? never : Kit

/**
 * A base toolkit and skills whose types still name their tools. One typed as any toolkit (a skill annotated
 * `Skill`, a list typed `ReadonlyArray<Skill>`, a base annotated `Toolkit.Any`) has lost its tools: they would be
 * offered and run, with what they declare missing from what the program is asked to provide. `skills` refuses
 * such arguments where they are passed, in these words.
 *
 * @public
 */
export type OwnSkills<Base extends Toolkit.Any, Skills extends ReadonlyArray<Skill>> = [Lost<Base> | Lost<Skills[number]["tools"]>] extends [never]
  ? unknown
  : "skills needs each toolkit's own type: a skill annotated Skill, or a base annotated Toolkit.Any, has lost its tools and what they declare"
