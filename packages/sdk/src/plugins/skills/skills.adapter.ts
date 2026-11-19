import { Effect, Layer, Option, Result, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import type { StoredEvent } from "@xandreed/core"
import { Memory } from "../../contracts/memory/memory.port.js"
import { catalogue, instructionsIn, loadedOf, noSkillNamed, offeredBy, rankOf, reloadNote, skillsProblem } from "../../contracts/skill/skill.entity.functions.js"
import { LOAD_SKILL, LoadedSkill } from "../../contracts/skill/skill.entity.js"
import type { Offered, OwnSkills } from "../../contracts/skill/skill.entity.functions.js"
import type { Skill } from "../../contracts/skill/skill.entity.js"
import { SentWhole } from "../../contracts/turn/sent-whole.port.js"

/**
 * The tool that loads a skill (ADR 0013). Its result is the skill's instructions, sent whole (`SentWhole`) in every
 * later prompt: loading is a call and its stored result, and nothing else. `skills(…)` puts it in its toolkit and
 * gives its handler.
 *
 * @public
 */
export const LoadSkill = Tool.make(LOAD_SKILL, {
  description: "Load a skill: returns the skill's instructions, and from your next step its tools are yours to call. Load a skill before you do what it covers. Loading one again returns its instructions again.",
  parameters: Schema.Struct({ skill: Schema.String.annotate({ description: "The skill's name." }) }),
  success: LoadedSkill,
  failure: Schema.String,
  failureMode: "return",
}).annotate(SentWhole, true)

const loader = Toolkit.make(LoadSkill)

/**
 * The tools of a host with skills: its base toolkit's, `loadSkill`, and every skill's.
 *
 * @public
 */
export type SkillTools<Base extends Toolkit.Any, Skills extends ReadonlyArray<Skill>> =
  Toolkit.MergedTools<readonly [Base, typeof loader, ...ReadonlyArray<Skills[number]["tools"]>]>

/**
 * A host's skills with its tools, as one value (ADR 0013): everything a loop needs of them comes from here, so the
 * skills and the tools cannot disagree.
 *
 * @public
 */
export interface SkillSet<Tools extends Record<string, Tool.Any>> {
  /** Every tool there is: the base's, `loadSkill`, and each skill's. Its handlers are the host's layers and `handlers`. */
  readonly toolkit: Toolkit.Toolkit<Tools>
  /** What the model reads of the skills before it loads any: for the host's system text, the same in every request. */
  readonly catalogue: string
  /** What `loadSkill` does: the handler of that one tool, to merge with the host's own handlers. */
  readonly handlers: Layer.Layer<Tool.HandlersFor<typeof loader.tools>>
  /**
   * The toolkit to offer and to call for one step, given the journal: the tools no skill owns, then each loaded
   * skill's in the order the skills were loaded. A load adds its skill's tools after those already offered, and
   * none is taken away. A call of a tool whose skill is not loaded fails as a call of an unknown tool does.
   */
  readonly offered: (journal: ReadonlyArray<StoredEvent>) => Offered<Tools>
  /**
   * A wrapper of `Memory` (ADR 0005): when a loaded skill's instructions are no longer in the context the memory
   * below returned (a compaction folded them, a window dropped them), it adds one note for the request, last,
   * naming those skills and how to read them again. It stores nothing and holds no instructions.
   */
  readonly withReloadNote: <E, R>(memory: Layer.Layer<Memory, E, R>) => Layer.Layer<Memory, E, R>
}

/**
 * A host's base toolkit and its skills, as one value (ADR 0013). The base's tools are always offered, and so is
 * `loadSkill`; a skill's tools are offered once the journal holds the result of the call that loaded it. Refused
 * here, where it is written, as a definition is: no skill at all, a skill that is none, two skills with one name,
 * or a tool that two of the base, the kernel and the skills have. Each argument keeps its own type (`OwnSkills`):
 * one typed as any toolkit has lost its tools, and is a compile error.
 *
 * @public
 */
export const skills = <Base extends Toolkit.Any, const Skills extends ReadonlyArray<Skill>>(base: Base & OwnSkills<Base, Skills>, ...list: Skills): SkillSet<SkillTools<Base, Skills>> => {
  Result.getOrThrowWith(skillsProblem(base, list), (problem) => new Error(problem))
  const kits: ReadonlyArray<Skills[number]["tools"]> = list.map((skill) => skill.tools)
  // The type is written out: left to infer, `merge` takes the skills' toolkits as any toolkit, and their tools are lost.
  const toolkit = Toolkit.merge<readonly [Base, typeof loader, ...ReadonlyArray<Skills[number]["tools"]>]>(base, loader, ...kits)
  const known = (id: string) => list.some((skill) => skill.id === id)
  return {
    toolkit,
    catalogue: catalogue(list),
    handlers: loader.toLayer({
      loadSkill: ({ skill }) => Option.match(Option.fromNullishOr(list.find((one) => one.id === skill)), {
        onNone: () => Effect.fail(noSkillNamed(skill, list)),
        onSome: (found) => Effect.succeed({ skill: found.id, instructions: found.instructions }),
      }),
    }),
    offered: (journal) => offeredBy<SkillTools<Base, Skills>>(toolkit, rankOf(list, loadedOf(journal))),
    withReloadNote: (below) => Layer.effect(Memory, Effect.map(Memory, (memory) => Memory.of({
      context: Effect.fnUntraced(function* (session) {
        const context = yield* memory.context(session)
        const held = instructionsIn(context)
        const gone = loadedOf(yield* session.journal).filter((id) => known(id) && !held.includes(id))
        return gone.length === 0 ? context : [...context, { role: "user" as const, content: reloadNote(gone) }]
      }),
    }))).pipe(Layer.provide(below)),
  }
}
