import { Option } from "effect"
import { dataOf } from "@xandreed/core"
import type { StoredEvent } from "@xandreed/core"
import {
  aliasedEvent, curatedEvent, curationFailedEvent, EntityId, entityEvent, memoryEndedEvent, memoryEvent, MemoryId, memoryRestatedEvent, SourceId, sourceEvent, SourceState,
  USER_ALIASES, USER_ENTITY, USER_NAME,
} from "./knowledge.entity.js"
import type { KeptRecords, Knowledge, KnownEntity, KnownMemory, KnownSource, NextIds, SaidBy, SourcePart } from "./knowledge.entity.js"

/**
 * A text as names and quotes are compared: its words in lower case, one space between them. Case, accent marks
 * and punctuation do not tell two texts apart ("João" is "joao", "St Mary's" is "st mary s"). Every letter and
 * digit of every script is kept, never only a to z. Only the accent marks of Latin, Greek and Cyrillic letters
 * (U+0300 to U+036F) are taken off; the marks other scripts write inside a word stay in it.
 *
 * @public
 */
export const folded = (text: string): string =>
  text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").trim()

/** Whether a folded text holds a folded name as a run of whole words: "ana silva" is in "my friend ana silva works", "ana" is not in "banana". */
export const holdsRun = (text: string, name: string): boolean => name.length > 0 && ` ${text} `.includes(` ${name} `)

/** Whether a text holds a quote, both folded: the quote's words, in order, whatever the case, the accents, the quote marks and the spacing. */
export const quoted = (text: string, quote: string): boolean => folded(quote).length > 0 && folded(text).includes(folded(quote))

/** The UTC day of a time in milliseconds, `YYYY-MM-DD`: how a prompt writes when something was said. A time that is no date reads as the first day there is. */
export const dayOf = (at: number): string => new Date(Number.isFinite(at) ? Math.min(Math.max(at, 0), 8.64e15) : 0).toISOString().slice(0, 10)

/** How each part of a source is labelled in the text a curator reads, by who said it. */
const LABELS: Record<SaidBy, string> = {
  user: "User: ",
  tool: "Tool ",
  assistant: "Assistant's final answer: ",
  host: "Host: ",
}

/**
 * One part of a source as a curator reads it: its label, then its text. A tool's part that names its call is the
 * call, then what it came to: `Tool lookupOrder, called with {"order":"QX-1"}, returned: shipped` (or `failed:`).
 */
export const partText = (part: SourcePart): string =>
  part.by === "tool" && part.call !== undefined
    ? `${LABELS.tool}${part.call.text}, ${part.call.failed ? "failed" : "returned"}: ${part.text}`
    : `${LABELS[part.by]}${part.text}`

/**
 * What a part says, to find names in: its text, and for a tool's part its call too. A name the model put in a
 * call's parameters still shows its entity to the curator; it is evidence of nothing (`evidenceOf`).
 */
export const saidText = (part: SourcePart): string => (part.by === "tool" && part.call !== undefined ? `${part.call.text}\n${part.text}` : part.text)

/**
 * A source as the text a curator reads: its parts in order, a line each, labelled by who said it (`User: …`,
 * `Tool …`, `Assistant's final answer: …`, `Host: …`). It is made from the parts each time and never stored.
 *
 * @public
 */
export const sourceText = (source: { readonly said: ReadonlyArray<SourcePart> }): string => source.said.map(partText).join("\n")

/**
 * What of a source a memory may rest on: what the user said, what a tool returned and what the host wrote, each
 * with who said it. Never the assistant's words, and never a tool call's name or parameters, which the model wrote:
 * a quote is looked for in a part's own text.
 */
export const evidenceOf = (source: { readonly said: ReadonlyArray<SourcePart> }): ReadonlyArray<{ readonly by: "user" | "tool" | "host"; readonly text: string }> =>
  source.said.flatMap((part) => (part.by === "assistant" ? [] : [{ by: part.by, text: part.text }]))

const PENDING: SourceState = { _tag: "Pending" }
const CURATED: SourceState = { _tag: "Curated" }

/** The user's entity, which every fold holds and no record stores. */
const USER: KnownEntity = { id: USER_ENTITY, name: USER_NAME, kind: "person", aliases: USER_ALIASES, source: Option.none() }

/**
 * What a knowledge session's journal holds (ADR 0022): a pure fold of its records, in order, that refuses no
 * journal.
 *
 * - `entities`: the user's first (`USER_ENTITY`), then each `plugin.knowledge.entity`, with the other names its
 *   `plugin.knowledge.aliased` records gave it, each once however often it was said.
 * - `memories`: every `plugin.knowledge.memory`, in the order written, with how often it was said (1, and one more
 *   for each `plugin.knowledge.restated`), when it was first and last said, the sources that said it, and how it
 *   ended, if a `plugin.knowledge.ended` names it. A memory that ended stays in the list: nothing is deleted.
 * - Every time of a memory is its source's `at`, when what the source holds happened, never when a record was
 *   stored: a turn curated a week late is still said on its own day, and ends what it ends on that day.
 * - `sources`: each `plugin.knowledge.source` with its state: `Pending`, `Curated` once a
 *   `plugin.knowledge.curated` names it, or `Failed` with how many tries and why the last failed. A source that
 *   was curated stays so, whatever failed before or after.
 *
 * A record it does not know is passed over. So is a record that names an id no earlier record made (a memory about
 * an entity that is not there, an end of a memory that is not there), one whose own id is taken, a second end of a
 * memory, and a restatement of a memory that ended.
 *
 * @public
 */
export const knowledgeOf = (journal: ReadonlyArray<StoredEvent>): Knowledge => {
  const sources = new Map<SourceId, KnownSource>()
  const entities = new Map<EntityId, KnownEntity>([[USER.id, USER]])
  const memories = new Map<MemoryId, KnownMemory>()
  for (const event of journal) {
    Option.map(dataOf(sourceEvent, event), (source) => {
      if (!sources.has(source.id)) sources.set(source.id, { source, stored: event.at, state: PENDING })
    })
    Option.map(dataOf(entityEvent, event), ({ id, name, kind, source }) => {
      if (!entities.has(id) && sources.has(source)) entities.set(id, { id, name, kind, aliases: [], source: Option.some(source) })
    })
    Option.map(dataOf(aliasedEvent, event), ({ id, alias, source }) => {
      const entity = entities.get(id)
      if (entity === undefined || !sources.has(source)) return
      const known = [entity.name, ...entity.aliases].map(folded)
      if (!known.includes(folded(alias))) entities.set(id, { ...entity, aliases: [...entity.aliases, alias] })
    })
    Option.map(dataOf(memoryEvent, event), ({ id, kind, text, about, quote, by, source, on }) => {
      const said = sources.get(source)
      if (memories.has(id) || said === undefined || about.some((entity) => !entities.has(entity))) return
      memories.set(id, { id, kind, text, about, quote, by, on: Option.fromNullishOr(on), count: 1, first: said.source.at, last: said.source.at, sources: [source], ended: Option.none() })
    })
    Option.map(dataOf(memoryRestatedEvent, event), ({ id, source }) => {
      const memory = memories.get(id)
      const said = sources.get(source)
      if (memory === undefined || Option.isSome(memory.ended) || said === undefined) return
      memories.set(id, {
        ...memory,
        count: memory.count + 1,
        first: Math.min(memory.first, said.source.at),
        last: Math.max(memory.last, said.source.at),
        sources: memory.sources.includes(source) ? memory.sources : [...memory.sources, source],
      })
    })
    Option.map(dataOf(memoryEndedEvent, event), ({ id, why, by, source }) => {
      const memory = memories.get(id)
      const said = sources.get(source)
      if (memory === undefined || Option.isSome(memory.ended) || said === undefined || (by !== undefined && !memories.has(by))) return
      memories.set(id, { ...memory, ended: Option.some({ at: said.source.at, why, by: Option.fromNullishOr(by) }) })
    })
    Option.map(dataOf(curatedEvent, event), ({ source }) => {
      const known = sources.get(source)
      if (known !== undefined) sources.set(source, { ...known, state: CURATED })
    })
    Option.map(dataOf(curationFailedEvent, event), ({ source, attempt, reason }) => {
      const known = sources.get(source)
      if (known === undefined) return
      sources.set(source, {
        ...known,
        state: SourceState.match(known.state, {
          Pending: (): SourceState => ({ _tag: "Failed", attempts: Math.max(1, attempt), reason }),
          Curated: (curated): SourceState => curated,
          Failed: ({ attempts }): SourceState => ({ _tag: "Failed", attempts: Math.max(attempts + 1, attempt), reason }),
        }),
      })
    })
  }
  return { entities: [...entities.values()], memories: [...memories.values()], sources: [...sources.values()] }
}

/**
 * The memories that stand: those no `plugin.knowledge.ended` names, in the order written.
 *
 * @public
 */
export const standing = (knowledge: Knowledge): ReadonlyArray<KnownMemory> => knowledge.memories.filter((memory) => Option.isNone(memory.ended))

/**
 * What a memory replaced: the memories that ended with `id` as what came in their place, in the order written.
 * None for a memory that replaced nothing.
 *
 * @public
 */
export const endedBy = (knowledge: Knowledge, id: MemoryId): ReadonlyArray<KnownMemory> =>
  knowledge.memories.filter((memory) => Option.exists(memory.ended, (ended) => Option.contains(ended.by, id)))

/** One more than the highest number among ids of one letter (`n7` is 7): the number the next one takes. */
const numberAfter = (ids: ReadonlyArray<string>): number => 1 + ids.reduce((highest, id) => Math.max(highest, Number(id.slice(1))), 0)

/**
 * The ids the next source, entity and memory take: one more than the highest the knowledge holds of each. The
 * user's entity is `n1`, so the first stored entity is `n2`; a memory that ended is still held, so its id is not
 * given again.
 *
 * @public
 */
export const nextIds = (knowledge: Knowledge): NextIds => ({
  source: SourceId.make(`s${numberAfter(knowledge.sources.map((one) => one.source.id))}`),
  entity: EntityId.make(`n${numberAfter(knowledge.entities.map((one) => one.id))}`),
  memory: MemoryId.make(`m${numberAfter(knowledge.memories.map((one) => one.id))}`),
})

/**
 * What a curation stored for one source, read back from the knowledge session's journal: every record that names the
 * source, by kind, in the order stored (`KeptRecords`). Pure, and it refuses no journal: what it does not know it
 * passes over. A client draws what a curation did from it, the same after a reload.
 *
 * @public
 */
export const keptFrom = (journal: ReadonlyArray<StoredEvent>, source: SourceId): KeptRecords => {
  const of = <D extends { readonly source: SourceId }>(read: (event: StoredEvent) => Option.Option<D>): ReadonlyArray<D> =>
    journal.flatMap((event) => Option.toArray(Option.filter(read(event), (data) => data.source === source)))
  return {
    entities: of((event) => dataOf(entityEvent, event)),
    aliases: of((event) => dataOf(aliasedEvent, event)),
    memories: of((event) => dataOf(memoryEvent, event)),
    restated: of((event) => dataOf(memoryRestatedEvent, event)),
    ended: of((event) => dataOf(memoryEndedEvent, event)),
    curated: Option.fromNullishOr(of((event) => dataOf(curatedEvent, event))[0]),
    failed: of((event) => dataOf(curationFailedEvent, event)),
  }
}
