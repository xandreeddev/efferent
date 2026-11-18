import { Option } from "effect"
import { SHOWN_LIMITS, USER_ENTITY } from "./knowledge.entity.js"
import type { EntityId, Knowledge, KnownEntity, KnownMemory, MemoryId, ShownKnowledge, ShownLimits, SourcePart } from "./knowledge.entity.js"
import { folded, holdsRun } from "./knowledge.entity.functions.js"

/** The words of a text that can tie it to another: folded, three characters or more. */
const wordsOf = (text: string): ReadonlyArray<string> => folded(text).split(" ").filter((word) => word.length >= 3)

/** Two words meet when they are the same, or when both are four characters or more and one starts the other ("move", "moved"). */
const meets = (a: string, b: string): boolean => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)))

/** The kind of entity whose first name alone can name it. */
const PERSON = "person"

/** How an entity came to be shown: 0 the user, 1 named in full by the source, 2 named in full by the context, 3 a person whose first name the source holds. */
interface Ranked {
  readonly entity: KnownEntity
  readonly rank: number
}

/**
 * What a curator is shown of the knowledge for one source (ADR 0022): the stored entities and memories that may
 * relate to it. Pure: the same knowledge, source and limits give the same lists, in the same order.
 *
 * - **Entities**, at most `limits.entities`: the user; then those the source's text names in full, by name or by
 *   another name they bear; then those its context names in full; then people (entities of kind `person`) whose
 *   first name the source holds. Names are compared folded: case, accent marks and punctuation do not tell names
 *   apart, in any script, and a name must be a run of whole words ("Ana" is not named by "banana").
 * - **Memories**, at most `limits.memories`: for each entity named in full, and the user, the memories it is the
 *   first `about` of, at most `limits.each`; then, while places are left, any other memory about a shown entity,
 *   more of the same entities' among them. In each group those that
 *   stand come before those that ended, then those that share most words with the source, then those about an
 *   entity shown for a stronger reason, then the latest said.
 * - Every entity a shown memory is about is added to the entities, since a memory's line names them by id.
 *
 * It shows what is stored about the entities named, not the memories nearest the source by likeness, because the
 * memory a source changes often shares no word with it ("And she moved to Braga last month" against "Ana Silva
 * lives in Porto"). Measured on 2026-11-18 over 40 scripted turns, on the prototype this function is a rewrite of:
 * of the 20 stored memories a turn says again, ends or must leave standing, the 12 nearest by shared words held
 * 17, missing the memory a turn changes in 3 cases, and this choice held 20. That is a small set, and nobody in it
 * had more than 30 memories.
 *
 * The source's words are its parts' texts, without the labels a curator reads them under: "User" names no entity,
 * and shares no word with "The user lives in Lisbon". The context is read as it is stored, labels included.
 *
 * A memory about no entity is never shown, and a name in a script written without spaces between words is not
 * found as a run of whole words.
 *
 * @public
 */
export const shownFor = (
  knowledge: Knowledge,
  source: { readonly said: ReadonlyArray<SourcePart>; readonly context?: string },
  limits: ShownLimits = SHOWN_LIMITS,
): ShownKnowledge => {
  // What was said, without the labels a curator reads it under ("User: ", "Tool "): a label is no word of the
  // source's, and "user" would meet every memory that says "the user".
  const text = source.said.map((part) => part.text).join("\n")
  const own = folded(text)
  const before = folded(source.context ?? "")
  const ranked = knowledge.entities.flatMap((entity): ReadonlyArray<Ranked> => {
    const names = [entity.name, ...entity.aliases].map(folded)
    const first = folded(entity.name).split(" ")[0] ?? ""
    const rank = entity.id === USER_ENTITY ? 0
      : names.some((name) => holdsRun(own, name)) ? 1
        : names.some((name) => holdsRun(before, name)) ? 2
          : entity.kind === PERSON && first.length >= 3 && holdsRun(own, first) ? 3 : 9
    return rank < 9 ? [{ entity, rank }] : []
  }).toSorted((a, b) => a.rank - b.rank).slice(0, Math.max(0, limits.entities))
  const rankOf = new Map<EntityId, number>(ranked.map(({ entity, rank }) => [entity.id, rank]))
  const words = wordsOf(text)
  const scored = knowledge.memories
    .filter((memory) => memory.about.some((id) => rankOf.has(id)))
    .map((memory) => ({
      memory,
      shared: wordsOf(memory.text).filter((word) => words.some((other) => meets(word, other))).length,
      rank: Math.min(...memory.about.map((id) => rankOf.get(id) ?? 9)),
    }))
    .toSorted((a, b) => Number(Option.isSome(a.memory.ended)) - Number(Option.isSome(b.memory.ended)) || b.shared - a.shared || a.rank - b.rank || b.memory.last - a.memory.last)
  const most = Math.max(0, limits.memories)
  const chosen = new Map<MemoryId, KnownMemory>()
  // Each entity named in full, and the user, first gets places for the memories it is the subject of, so an entity
  // many memories mention (an employer, a city) cannot crowd a person out.
  for (const { entity } of ranked.filter(({ rank }) => rank <= 2)) {
    for (const { memory } of scored.filter((one) => one.memory.about[0] === entity.id).slice(0, Math.max(0, limits.each))) {
      if (chosen.size < most) chosen.set(memory.id, memory)
    }
  }
  for (const { memory } of scored) if (chosen.size < most) chosen.set(memory.id, memory)
  const memories = [...chosen.values()]
  const more = [...new Set(memories.flatMap((memory) => memory.about))].filter((id) => !rankOf.has(id)).flatMap((id) => knowledge.entities.filter((entity) => entity.id === id))
  return { entities: [...ranked.map(({ entity }) => entity), ...more], memories }
}
