// What lesson 18's Graph tab shows, worked out from what the page heard: the
// memory the knowledge session holds, drawn as entities and the memories
// between them, as soon as it holds any and with no question asked; and on
// top of it, lit, what the latest curation did and what the latest recall
// sent. The page hears the knowledge session's records as every kernel event
// (the `Event` trace), and `withKnowledge` says what it did for each request
// as `plugin.knowledge.recalled`; this file folds both, with no listener of
// its own. Pure: no DOM, no clock. `panes/graph.ts` draws what it gives.
import { Option } from "effect"
import { dataOf } from "@xandreed/core"
import type { StoredEvent } from "@xandreed/core"
import {
  aliasedEvent, curatedEvent, curationFailedEvent, entityEvent, estimateTokens, keptFrom, knowledgeNote, knowledgeOf, knowledgeRecalledEvent, memoryEndedEvent, memoryEvent,
  memoryRestatedEvent, sourceEvent, standing, USER_ENTITY,
} from "@xandreed/sdk"
import type { Knowledge, KnowledgeRecalledData, KnownMemory } from "@xandreed/sdk"
import type { Trace } from "./runtime.ts"

/** One request's recall, as the page heard it: the turn of the conversation, and which of its model calls (from 1). */
export interface HeardRecall {
  readonly turn: number
  readonly call: number
  readonly recalled: KnowledgeRecalledData
}

/**
 * Everything the Graph tab draws from: each recall heard in the conversation shown, in order, and the knowledge
 * session's records, whichever conversation stored them.
 */
export interface RecallBoard {
  readonly chat: string
  readonly recalls: ReadonlyArray<HeardRecall>
  readonly records: ReadonlyArray<StoredEvent>
}

export const emptyRecalls = (chat: string): RecallBoard => ({ chat, recalls: [], records: [] })

/** The knowledge session's records, by their names: what `knowledgeOf` reads. */
const KEPT = [sourceEvent, entityEvent, aliasedEvent, memoryEvent, memoryRestatedEvent, memoryEndedEvent, curatedEvent, curationFailedEvent].map((event) => event.name)

/**
 * The board after one more trace: a recall said in the conversation shown is the next model call of its turn (memory
 * builds one context, and recall runs once, for each call); a record of the knowledge session's is kept, from any
 * session. Any other trace changes nothing, and the board is returned as it was.
 */
export const heardRecall = (board: RecallBoard, trace: Trace): RecallBoard => {
  if (trace._tag !== "Event") return board
  const event = trace.event
  if (event._tag === "Stored") {
    const { session: _session, _tag: _stored, ...record } = event
    return KEPT.includes(record.name) ? { ...board, records: [...board.records, record] } : board
  }
  if (event.session !== board.chat) return board
  return Option.match(dataOf(knowledgeRecalledEvent, event), {
    onNone: () => board,
    onSome: (recalled) => {
      const turn = event.turn ?? 0
      const call = board.recalls.filter((one) => one.turn === turn).length + 1
      return { ...board, recalls: [...board.recalls, { turn, call, recalled }] }
    },
  })
}

/** The board as a new conversation starts (Clear context): its recalls are the old conversation's; the records stay. */
export const recallsStartedOver = (board: RecallBoard, chat: string): RecallBoard => ({ chat, recalls: [], records: board.records })

/** Which recall the tab shows: the latest, or one picked by its turn and call. */
export type RecallPick = { readonly _tag: "Latest" } | { readonly _tag: "Call"; readonly turn: number; readonly call: number }

/** The recall picked, when the board holds it; the latest, when it holds none picked. */
export const pickedRecall = (board: RecallBoard, pick: RecallPick): Option.Option<HeardRecall> =>
  pick._tag === "Call"
    ? Option.orElse(Option.fromNullishOr(board.recalls.find((one) => one.turn === pick.turn && one.call === pick.call)), () => Option.fromNullishOr(board.recalls.at(-1)))
    : Option.fromNullishOr(board.recalls.at(-1))

/** How many model calls a turn has a recall for. */
const callsOf = (board: RecallBoard, turn: number): number => board.recalls.filter((one) => one.turn === turn).length

/** A recall's name in the tab's picker: its turn, and its model call when the turn made more than one. */
export const recallLabel = (board: RecallBoard, heard: HeardRecall): string => {
  const calls = callsOf(board, heard.turn)
  return calls > 1 ? `Turn ${heard.turn}, model call ${heard.call} of ${calls}` : `Turn ${heard.turn}`
}

/**
 * What the chat's status line says when Stop, Rebuild or Clear context cut a curation short (lesson 18): the program's
 * "Curating…" would otherwise stay, though nothing curates.
 */
export const curationCutLine = (source: string): string => `Curating stopped: ${source} was not kept yet, and the next turn takes it up.`

/** What the tab says while the knowledge session holds no memory. */
export const NOTHING_KEPT = "Nothing is kept yet. Send a message that says something, such as the first button under the chat: once the chat has answered, the curator keeps what the turn said, and it is drawn here. Or press Load the world."

/** What the recall's panel says while no request of this conversation has been sent: nothing was recalled yet. */
export const NO_RECALL = "No request of this conversation has been sent yet. Send a message: withKnowledge chooses what each request is sent, and why shows here."

/** Which entities the picture draws: those the conversation named, with their neighbours, or every one. */
export type Showing = "named" | "everything"

/** How many neighbours of one entity the picture draws at most, the most said first, unless everything is shown. */
export const NEIGHBOURS = 6

/** How many entities the most-said fallback starts from. */
export const MOST_SAID = 5

/** How many entities one column holds before the next column takes the rest. */
export const COLUMN_ROWS = 24

/** How an entity is lit: a seed of the latest recall, an entity its walk by subject started from, or neither. */
export type ThingLight = "seed" | "bridge"

/** An entity the picture draws, and where. */
export interface ThingView {
  readonly key: string
  readonly label: string
  readonly kind: string
  readonly column: number
  readonly row: number
  readonly light: Option.Option<ThingLight>
  /** The memories about this entity alone, listed under it: their sentences. */
  readonly alone: ReadonlyArray<string>
  /** What it says when pointed at. */
  readonly title: string
}

/** How a memory is lit: sent with the latest request, kept by the latest curation, or neither. */
export type EdgeLight = "sent" | "curated"

/** A memory the picture draws between two entities: from its subject, its first `about`, to another it is about. */
export interface EdgeView {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly text: string
  /** From 1 to 4: thicker the more often said, against the most said memory drawn. */
  readonly width: number
  /** Drawn dashed: a memory that ended. */
  readonly ended: boolean
  readonly light: Option.Option<EdgeLight>
  readonly title: string
}

/** The picture of the memory, and what it shows in words. */
export interface MemoryView {
  /** What the picture shows, and why those entities. */
  readonly heading: string
  /** What the knowledge session holds, counted as `knowledgeOf` counts it. */
  readonly counts: string
  readonly things: ReadonlyArray<ThingView>
  readonly edges: ReadonlyArray<EdgeView>
}

/** What the latest curation of a turn did, in words: kept, ended, said again, dropped and why, or why it failed. */
export interface CurationView {
  readonly heading: string
  readonly lines: ReadonlyArray<string>
  /** The memories it stored, ended or said again: lit in the picture. */
  readonly memories: ReadonlyArray<string>
}

/** One memory of a recall, as the panel lists it. */
export interface RecallRow {
  readonly id: string
  readonly text: string
  readonly sent: boolean
  /** Its places in the lists, and how each was reached. */
  readonly how: ReadonlyArray<string>
  /** Why it was sent, or why not. */
  readonly why: string
  /** What it replaced, sent under it as "before that". */
  readonly before: ReadonlyArray<string>
}

/** What the tab says of one recall: the three steps, and what was sent. */
export interface RecallView {
  readonly question: string
  /** The options it ran with, as memory.ts writes them. */
  readonly options: string
  /** Step 1: each seed and how it was named, or why there was none. */
  readonly seeds: ReadonlyArray<string>
  /** Step 2's heading: the lists it fused, the list by meaning among them when it ran (lesson 20). */
  readonly lists: string
  /**
   * Step 2's word on the list by meaning, when the recall had one (lesson 20) and it found nothing to rank: why it was
   * skipped (the embedder's words), or that its weight turned it off.
   */
  readonly byMeaning: Option.Option<string>
  /** Step 2: the memories about the seeds, those the message's words reach, and those nearest it in meaning, fused by rank. */
  readonly ranked: ReadonlyArray<RecallRow>
  /** Step 3: the entities the walk by subject started from, and what it found. */
  readonly bridges: ReadonlyArray<string>
  readonly walked: ReadonlyArray<RecallRow>
  /** The memories past the event's list, counted. */
  readonly more: Option.Option<string>
  /** What was sent, its size, and the size of sending every standing memory. */
  readonly sent: string
}

/** A rank in words: 1st, 2nd, 3rd, 11th, 21st. */
export const ordinal = (n: number): string => {
  const tens = n % 100
  const suffix = tens >= 11 && tens <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th"
  return `${n}${suffix}`
}

/** A number as the panel writes it: 4,400. */
const counted = (n: number): string => n.toLocaleString("en-US")
const plural = (n: number, one: string, many: string): string => `${counted(n)} ${n === 1 ? one : many}`

/** The UTC day of a time, as the note writes it. */
const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10)

/** How often and when a memory was said, as the note says it. */
const saidWords = (memory: KnownMemory): string => (memory.count === 1 ? `said on ${dayOf(memory.first)}` : `said ${memory.count} times, last ${dayOf(memory.last)}`)

/** How much a memory was said, all its sayings together, for the entities it is about. */
const weightOf = (knowledge: Knowledge): ReadonlyMap<string, number> => {
  const weights = new Map<string, number>()
  for (const memory of standing(knowledge)) for (const id of memory.about) weights.set(id, (weights.get(id) ?? 0) + memory.count)
  return weights
}

/**
 * The entities the conversation named: the user, those the memories kept from its own turns are about, and the seeds
 * of its recalls; in that order, each once.
 */
export const namedBy = (knowledge: Knowledge, chat: string, recalls: ReadonlyArray<HeardRecall>): ReadonlyArray<string> => {
  const own = new Set(knowledge.sources.filter((one) => one.source.from?.session === chat).map((one) => String(one.source.id)))
  const kept = knowledge.memories.filter((memory) => memory.sources.some((source) => own.has(String(source)))).flatMap((memory) => memory.about.map(String))
  return [...new Set([String(USER_ENTITY), ...kept, ...recalls.flatMap((one) => one.recalled.seeds.map((seed) => String(seed.id)))])]
}

/**
 * The picture of the memory: entities and the memories between them, from the knowledge session's records alone, as
 * soon as it holds any. With `named`, the entities the conversation named (`namedBy`) and the latest recall's seeds,
 * with their neighbours, at most `NEIGHBOURS` of each, the most said first; when what was named holds no memory (Load
 * the world, nothing said yet, or a new conversation), the `MOST_SAID` entities said most often, and their neighbours.
 * With `everything`, every entity. Every entity a lit memory is about is drawn too. The first column is where the
 * picture starts (the seeds a memory is about, else the first named one, else the most said), and each other entity
 * is in the column of how many memories away from it it is; one no memory reaches goes in the first column. The latest
 * recall's seeds and the entities its walk started from are lit, and so is every memory it sent and every memory the
 * latest curation kept.
 */
export const memoryViewOf = (records: ReadonlyArray<StoredEvent>, showing: Showing, named: ReadonlyArray<string>, recall: Option.Option<KnowledgeRecalledData>, curation: Option.Option<CurationView>): MemoryView => {
  const knowledge = knowledgeOf(records)
  const entities = new Map(knowledge.entities.map((entity) => [String(entity.id), entity]))
  const weights = weightOf(knowledge)
  const memories = knowledge.memories
  const standingCount = standing(knowledge).length
  const counts = `The knowledge session holds ${plural(knowledge.entities.length, "entity", "entities")} and ${plural(memories.length, "memory", "memories")}, ${counted(memories.length - standingCount)} of them ended.`
  const sent = new Set<string>(Option.match(recall, { onNone: () => [], onSome: (one) => [...one.sent.map(String), ...one.memories.filter((memory) => memory.sent).flatMap((memory) => memory.before.map(String))] }))
  const kept = new Set<string>(Option.match(curation, { onNone: () => [], onSome: (one) => one.memories }))
  const seeds: ReadonlyArray<string> = Option.match(recall, { onNone: () => [], onSome: (one) => one.seeds.map((seed) => String(seed.id)) })
  const bridges: ReadonlyArray<string> = Option.match(recall, { onNone: () => [], onSome: (one) => one.bridges.map((bridge) => String(bridge.id)) })
  const neighbours = new Map<string, Array<string>>()
  for (const memory of memories) {
    for (const one of memory.about) for (const other of memory.about) if (one !== other) neighbours.set(String(one), [...(neighbours.get(String(one)) ?? []), String(other)])
  }
  const heaviest = (ids: Iterable<string>) => [...new Set(ids)].sort((a, b) => (weights.get(b) ?? 0) - (weights.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0))
  const holdsMemory = (id: string) => (neighbours.get(id) ?? []).length > 0 || memories.some((memory) => memory.about.length === 1 && String(memory.about[0]) === id)
  // Which entities are drawn: what the conversation named and the latest recall's seeds (or, when those hold no
  // memory, the entities said about most often), at most NEIGHBOURS neighbours of each, and every entity a lit memory
  // is about; with everything, every entity.
  const fromNamed = [...new Set([...seeds, ...named])].filter((id) => entities.has(id))
  const fallback = showing === "named" && !fromNamed.some(holdsMemory) && memories.length > 0
  const shownFrom = fallback ? [String(USER_ENTITY), ...heaviest(entities.keys()).filter((id) => id !== String(USER_ENTITY)).slice(0, MOST_SAID)] : fromNamed
  const lit = memories.filter((memory) => sent.has(String(memory.id)) || kept.has(String(memory.id)))
  const drawn = new Set<string>(showing === "everything" ? entities.keys() : [
    ...shownFrom, ...shownFrom.flatMap((id) => heaviest(neighbours.get(id) ?? []).slice(0, NEIGHBOURS)),
    ...lit.flatMap((memory) => memory.about.map(String)), ...bridges.filter((id) => entities.has(id)),
  ])
  // Columns: the first column is where the picture starts, the latest recall's seeds when they hold a memory, else the
  // first entity named that does (or the entities said about most often); the rest by how many memories away from it,
  // among those drawn. A drawn entity no memory reaches goes in the first column, under the start.
  const seeded = seeds.filter(holdsMemory)
  const begin = fallback ? shownFrom : seeded.length > 0 ? seeded : fromNamed.filter(holdsMemory).slice(0, 1)
  const column = new Map<string, number>(begin.map((id) => [id, 0]))
  let edge = begin
  for (let depth = 1; edge.length > 0; depth++) {
    const next = [...new Set(edge.flatMap((id) => heaviest(neighbours.get(id) ?? [])).filter((id) => drawn.has(id) && !column.has(id)))]
    for (const id of next) column.set(id, depth)
    edge = next
  }
  for (const id of [...shownFrom, ...drawn]) if (!column.has(id)) column.set(id, 0)
  // Rows: each column in the order its entities came, a long column wrapped into the next.
  const byColumn = new Map<number, Array<string>>()
  for (const [id, at] of column) byColumn.set(at, [...(byColumn.get(at) ?? []), id])
  const placed = new Map<string, { readonly column: number; readonly row: number }>()
  let shift = 0
  for (const at of [...byColumn.keys()].sort((a, b) => a - b)) {
    const ids = byColumn.get(at) ?? []
    ids.forEach((id, index) => placed.set(id, { column: at + shift + Math.floor(index / COLUMN_ROWS), row: index % COLUMN_ROWS }))
    shift += Math.max(0, Math.ceil(ids.length / COLUMN_ROWS) - 1)
  }
  const between = memories.filter((memory) => memory.about.length > 1 && memory.about.every((id) => placed.has(String(id))))
  const mostSaid = Math.max(1, ...between.map((memory) => memory.count))
  const lightOf = (memory: KnownMemory): Option.Option<EdgeLight> =>
    sent.has(String(memory.id)) ? Option.some("sent") : kept.has(String(memory.id)) ? Option.some("curated") : Option.none()
  const things = [...placed].map(([id, at]): ThingView => {
    const entity = entities.get(id)
    const label = entity?.name ?? id
    const alone = memories.filter((memory) => memory.about.length === 1 && String(memory.about[0]) === id).map((memory) => memory.text)
    const light: Option.Option<ThingLight> = seeds.includes(id) ? Option.some("seed") : bridges.includes(id) ? Option.some("bridge") : Option.none()
    const aliases = entity === undefined || entity.aliases.length === 0 ? "" : `, also called ${entity.aliases.join(", ")}`
    return {
      key: id, label, kind: entity?.kind ?? "thing", column: at.column, row: at.row, light, alone,
      title: `${id}: ${label} (${entity?.kind ?? "thing"}${aliases})${Option.match(light, { onNone: () => "", onSome: (how) => (how === "seed" ? ". A seed of the latest recall." : ". The walk by subject started from it.") })}`,
    }
  })
  const edges = between.flatMap((memory) => memory.about.slice(1).map((to): EdgeView => ({
    id: String(memory.id), from: String(memory.about[0]), to: String(to), text: memory.text,
    width: Math.round((1 + (3 * memory.count) / mostSaid) * 10) / 10,
    ended: Option.isSome(memory.ended), light: lightOf(memory),
    title: `${memory.id}: ${memory.text} (${saidWords(memory)}${Option.match(memory.ended, { onNone: () => "", onSome: (ended) => `; ended on ${dayOf(ended.at)}, ${ended.why}` })})`,
  })))
  const shown = things.length
  const heading = showing === "everything"
    ? `Everything the knowledge session holds: ${plural(shown, "entity", "entities")}, each in the column of how many memories away it is from where the picture starts.`
    : fallback
      ? `The conversation has named nothing kept yet, so these are the ${MOST_SAID} entities said about most often, on the left, and their neighbours: ${plural(shown, "entity", "entities")}.`
      : `The user and what the conversation named, with their neighbours, at most ${NEIGHBOURS} each, the most said first: ${plural(shown, "entity", "entities")}. The picture starts on the left from ${seeded.length > 0 ? "what your latest message named" : "the first of them a memory is about"}, a column for each memory further.`
  return { heading, counts, things, edges }
}

/**
 * What the latest curation of a turn did, read from the knowledge session's records: the last source whose curation
 * a curator answered (Load the world's, which no model curated, are passed over), what it kept, ended and said again,
 * and what the checks dropped, each with why; or that its last try failed, and why.
 */
export const latestCuration = (records: ReadonlyArray<StoredEvent>): Option.Option<CurationView> => {
  const outcome = records.findLast((record) =>
    Option.exists(dataOf(curatedEvent, record), (curated) => curated.calls > 0) || Option.isSome(dataOf(curationFailedEvent, record)))
  if (outcome === undefined) return Option.none()
  const knowledge = knowledgeOf(records)
  const textOf = (id: string) => knowledge.memories.find((memory) => String(memory.id) === id)?.text ?? id
  return Option.match(dataOf(curationFailedEvent, outcome), {
    onSome: (failed) => Option.some({ heading: `Source ${failed.source}: try ${failed.attempt} failed.`, lines: [failed.reason, "The program's next turn takes it up again."], memories: [] }),
    onNone: () => Option.map(dataOf(curatedEvent, outcome), (curated): CurationView => {
      const kept = keptFrom(records, curated.source)
      const source = knowledge.sources.find((one) => one.source.id === curated.source)
      const turn = Option.match(Option.fromNullishOr(source?.source.from), { onNone: () => "", onSome: (from) => ` (turn ${from.turn} of a conversation)` })
      const lines = [
        ...kept.memories.map((memory) => `New: ${memory.text}`),
        ...kept.ended.map((ended) => `Ended (${ended.why}): ${textOf(String(ended.id))}${ended.by === undefined ? "" : `, replaced by ${textOf(String(ended.by))}`}`),
        ...kept.restated.map((again) => `Said again: ${textOf(String(again.id))}`),
        ...curated.dropped.map((dropped) => `Dropped: ${dropped.what}. ${dropped.why}`),
      ]
      return {
        heading: `Source ${curated.source}${turn}: ${plural(curated.calls, "model call", "model calls")}, ${plural(kept.memories.length, "new memory", "new memories")}, ${counted(kept.ended.length)} ended, ${counted(kept.restated.length)} said again, ${counted(curated.dropped.length)} dropped.`,
        lines: lines.length === 0 ? ["Nothing to keep: the turn said nothing the curator kept."] : lines,
        memories: [...kept.memories.map((memory) => String(memory.id)), ...kept.ended.map((ended) => String(ended.id)), ...kept.restated.map((again) => String(again.id))],
      }
    }),
  })
}

/** How a seed was named, in words. */
const seedWords = (seed: KnowledgeRecalledData["seeds"][number]): string =>
  seed.by === "name" ? `${seed.name}, by its name in your message: "${seed.word}"`
    : seed.by === "speaker" ? `${seed.name}, by a word with which you name yourself: "${seed.word}"`
      : seed.by === "first-name" ? `${seed.name}, by a first name in your message, which named nobody in full: "${seed.word}"`
        : `${seed.name}, named in the turn before: your message named nobody`

/**
 * What the tab says of one recall: the seeds and how each was named; the memories ranked, each with its place in the
 * list about a seed and in the list the message's words reach (with those words), "for what replaced it" where an
 * ended memory took the place; what the walk by subject started from and found; whether each was sent and why or why
 * not; and the note's size in tokens against the size of sending every standing memory. `records` are the knowledge
 * session's, as heard.
 */
export const recallViewOf = (recalled: KnowledgeRecalledData, records: ReadonlyArray<StoredEvent>): RecallView => {
  const knowledge = knowledgeOf(records)
  const names = new Map(knowledge.entities.map((entity) => [String(entity.id), entity.name]))
  const textOf = (id: string) => knowledge.memories.find((memory) => String(memory.id) === id)?.text ?? id
  const rowOf = (memory: KnowledgeRecalledData["memories"][number]): RecallRow => {
    const replaced = (via: string | null) => (via === null ? "" : `, for what replaced it (${textOf(via)} ranked there)`)
    const how = [
      ...(memory.seed === null ? [] : [`${ordinal(memory.seed.place)} about a seed (${memory.seed.seeds.map((id) => names.get(String(id)) ?? id).join(", ")})${replaced(memory.seed.via)}`]),
      ...(memory.words === null ? [] : [`${ordinal(memory.words.place)} by your words (${memory.words.terms.join(", ")})${replaced(memory.words.via)}`]),
      ...(memory.meaning === null ? [] : [`${ordinal(memory.meaning.place)} by meaning (cosine ${memory.meaning.cosine.toFixed(3)})${replaced(memory.meaning.via)}`]),
      ...(memory.walk === null ? [] : [`${ordinal(memory.walk.place)} of the walk, from ${names.get(String(memory.walk.from)) ?? memory.walk.from}`]),
    ]
    const why = memory.why === "ranked" ? `sent: among the first ${recalled.limit} of the fused list`
      : memory.why === "walked" ? "sent: one of the walk's places"
        : memory.why === "past-limit" ? `not sent: past the limit of ${recalled.limit}`
          : `not sent: past the walk's ${recalled.walk} places`
    return { id: String(memory.id), text: memory.text, sent: memory.sent, how, why, before: memory.before.map((id) => textOf(String(id))) }
  }
  const all = standing(knowledge)
  const everyTokens = Number(estimateTokens(knowledgeNote(all.map((memory) => ({ memory, why: "ranked" as const, before: [] })))))
  return {
    question: recalled.last,
    options: recalled.meaning === null
      ? `limit: ${recalled.limit} · walk: ${recalled.walk}`
      : `limit: ${recalled.limit} · walk: ${recalled.walk} · pool: ${recalled.meaning.pool} · weights: seed ${recalled.weights.seed}, words ${recalled.weights.words}, meaning ${recalled.weights.meaning}${recalled.meaning.floor === null ? "" : ` · floor: ${recalled.meaning.floor}`} · vectors of ${recalled.meaning.model}`,
    seeds: recalled.seeds.length === 0 ? ["Nothing: your message and the turn before it named no entity kept, and held none of your words for yourself."] : recalled.seeds.map(seedWords),
    lists: recalled.meaning === null ? "Memories about the seeds, and those your words reach, fused" : "Memories about the seeds, those your words reach, and those nearest your message in meaning, fused",
    byMeaning: recalled.meaning === null ? Option.none()
      : recalled.meaning.skipped !== null ? Option.some(`Nothing was ranked by meaning. ${recalled.meaning.skipped} Recall used the other lists.`)
        : recalled.weights.meaning === 0 ? Option.some("The list by meaning is off: its weight is 0, so nothing was turned into numbers.")
          : Option.none(),
    ranked: recalled.memories.filter((memory) => memory.walk === null).map(rowOf),
    bridges: recalled.bridges.map((bridge) => `${bridge.name}, brought in by "${textOf(String(bridge.from))}"`),
    walked: recalled.memories.filter((memory) => memory.walk !== null).map(rowOf),
    more: recalled.more > 0 ? Option.some(`And ${plural(recalled.more, "more memory", "more memories")} ranked after these.`) : Option.none(),
    sent: recalled.sent.length === 0
      ? `Sent no memory. Sending every standing memory, all ${counted(all.length)}, would take about ${counted(everyTokens)} tokens.`
      : `Sent ${plural(recalled.sent.length, "memory", "memories")}, in a note of about ${counted(recalled.tokens)} tokens. Sending every standing memory, all ${counted(all.length)}, would take about ${counted(everyTokens)} tokens.`,
  }
}
