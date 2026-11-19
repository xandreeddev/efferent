// Lesson 18's Load the world: the page writes the world (world.ts) into the
// knowledge session as records, in one turn, with no model: what a curator
// that made no mistake would have kept from the world's 654 sentences. Each
// day the world says something is one source (`plugin.knowledge.source`, a
// host part listing that day's sentences, at noon UTC that day), so the note
// says each memory was said on its own day; each source is closed with a
// `plugin.knowledge.curated` of no model call, so no program takes it up
// again. A sentence's first saying is a memory about the entities it names,
// a saying after it a restatement (`plugin.knowledge.restated`), and a later
// employer or home ends the earlier one (`plugin.knowledge.ended`, changed).
// Entities are one per name, compared as the knowledge contract compares names
// (`folded`): a name the knowledge session holds already, as a name or
// as another name, is that entity, and two names the world means as one (Lisboa
// and Lisbon, Acme and Acme Labs) are one entity under its name, with the
// other as another name (`plugin.knowledge.aliased`). The journal stamps a
// record with the clock of the fiber that appends it, so each append is given
// a clock that reads its day.
import { Clock, Effect, Option, Result } from "effect"
import { dataOf, Sessions, stored } from "@xandreed/core"
import type { StoredDraft, StoredEvent } from "@xandreed/core"
import {
  aliasedEvent, curatedEvent, EntityId, entityEvent, folded, knowledgeOf, knowledgeSession, memoryEndedEvent, memoryEvent, MemoryId, memoryRestatedEvent, nextIds, SourceId,
  sourceEvent, standing,
} from "@xandreed/sdk"
import type { Knowledge, MemoryKind } from "@xandreed/sdk"
import { WORLD } from "./world.ts"
import type { WorldEntry } from "./world.ts"

/** What a source the world wrote carries in its `meta`: a load is told from a curated turn by it. */
export const WORLD_META = { written: "Load the world" } as const

/** What Load the world says when the knowledge session holds the world already: a second load would say each sentence twice. */
export const LOADED_ALREADY = "The world is loaded already: the knowledge session holds its sentences, and a second load would say each one twice. A reload of the page empties the knowledge session."

/**
 * A clock that reads `at` (milliseconds) for the time of day, and is the live clock for everything else: how long
 * something takes, and a sleep. Each of the seven members is written out, so it is a `Clock` by its type alone.
 */
export const clockAt = (at: number, live: Clock.Clock): Clock.Clock => ({
  currentTimeMillisUnsafe: () => at,
  currentTimeMillis: Effect.succeed(at),
  currentTimeNanosUnsafe: () => BigInt(at) * 1_000_000n,
  currentTimeNanos: Effect.succeed(BigInt(at) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: live.monotonicTimeNanos,
  sleep: (duration) => live.sleep(duration),
})

/** Noon, UTC, of the day a sentence was said: the time of its day's source, and of every record stored for it. */
export const noonOf = (said: string): number => Date.parse(`${said}T12:00:00Z`)

/** Names the world means as one thing: another name, then the name it is stored under when it is new. */
const SAME: ReadonlyArray<readonly [other: string, name: string]> = [["Lisboa", "Lisbon"], ["Acme", "Acme Labs"]]

/** A pet's relation: its object is the pet, by its name. */
const PET = /^has (?:dog|cat|parrot|turtle|hamster|rabbit)$/

/** Relations whose object is an entity of its own: a place, an organization, a person, a pet or a project. Any other object (tea, chess, a goal) is said in the memory's sentence alone. */
const TO_ENTITY = /^(?:works at|lives in|is in|belongs to|leads|plans trip to|met|has (?:dog|cat|parrot|turtle|hamster|rabbit)|was renamed|partners with|hosts meetup in|visited|travelled to|has office in|favourite city is)$/

/** Relations a person holds one of at a time: a later one, to another entity, ends the earlier. */
const ONE_AT_A_TIME = /^(?:works at|lives in)$/

/** The kind of the entity a sentence's subject names. */
const subjectKind = (subject: string, relation: string): string =>
  /^Project /.test(subject) ? "project"
    : /^(?:is in|was renamed|partners with|has office in|hosts meetup in)$/.test(relation) ? "organization"
      : "person"

/** The kind of the entity a sentence's object names, when it names one (`TO_ENTITY`). */
const objectKind = (relation: string, object: string): string =>
  /^Project /.test(object) ? "project"
    : PET.test(relation) ? "pet"
      : /^(?:lives in|is in|plans trip to|hosts meetup in|visited|travelled to|has office in|favourite city is)$/.test(relation) ? "place"
        : /^(?:works at|belongs to|partners with|was renamed)$/.test(relation) ? "organization"
          : "person"

/** The kind of memory a sentence is, by its relation. */
const memoryKind = (relation: string): MemoryKind =>
  /^(?:likes|enjoys|favourite|drinks|eats)/.test(relation) ? "preference"
    : /^(?:has goal|wants to learn|is learning)/.test(relation) ? "goal"
      : /^(?:plans trip to|flies|visited|travelled to|met|bought)/.test(relation) ? "event"
        : "fact"

/** A sentence of the world as its memory's text. */
export const sentenceOf = ([subject, relation, object]: WorldEntry): string => `${subject} ${relation} ${object}.`

/** How many records of each kind a load wrote, and the first and last ids it gave. */
export interface WorldCounts {
  readonly sources: number
  readonly entities: number
  readonly aliases: number
  readonly memories: number
  readonly restated: number
  readonly ended: number
  readonly curated: number
}

/** The records of a load, each with the time it is stored at, and how many of each kind. */
export interface WorldDrafts {
  readonly drafts: ReadonlyArray<{ readonly draft: StoredDraft; readonly at: number }>
  readonly counts: WorldCounts
}

/** The number of an id of one letter (`n7` is 7). */
const numberOf = (id: string): number => Number(id.slice(1))

/**
 * Every record of a load, over the knowledge as it stands (`knowledge`): ids go on from the highest it holds, an
 * entity it holds by a name or another name is that entity, and a sentence a memory that stands says word for word,
 * or one that ended after the sentence's day, is that memory said again. Ends are the world's own: a later employer
 * or home ends the earlier one the world said, never one a conversation stored.
 */
export const worldDrafts = (knowledge: Knowledge, world: ReadonlyArray<WorldEntry> = WORLD): WorldDrafts => {
  const next = nextIds(knowledge)
  let source = numberOf(next.source)
  let entity = numberOf(next.entity)
  let memory = numberOf(next.memory)
  // Entities by each name they bear, folded as the knowledge contract compares names; the user's is no name the world says.
  const byName = new Map<string, EntityId>()
  for (const known of knowledge.entities.slice(1)) for (const name of [known.name, ...known.aliases]) byName.set(folded(name), known.id)
  const aliasesOf = new Map<EntityId, Set<string>>(knowledge.entities.map((known) => [known.id, new Set([known.name, ...known.aliases].map(folded))]))
  const byText = new Map<string, MemoryId>(standing(knowledge).map((known) => [folded(known.text), known.id]))
  // The memories that ended, by their sentence: a sentence the world says before one of them ended is that memory.
  const endedText = new Map<string, { readonly id: MemoryId; readonly at: number }>(knowledge.memories.flatMap((known) =>
    Option.match(known.ended, { onNone: () => [], onSome: (ended) => [[folded(known.text), { id: known.id, at: ended.at }] as const] })))
  // Each person's employer and home that stand, by the person and the relation: the memory and the entity it names.
  const holding = new Map<string, { readonly id: MemoryId; readonly entity: EntityId }>()
  const drafts: Array<{ readonly draft: StoredDraft; readonly at: number }> = []
  const counts = { sources: 0, entities: 0, aliases: 0, memories: 0, restated: 0, ended: 0, curated: 0 }
  // The days in the order said, each with its sentences.
  const days = new Map<string, Array<WorldEntry>>()
  for (const entry of world) days.set(entry[3], [...(days.get(entry[3]) ?? []), entry])
  for (const [day, said] of days) {
    const at = noonOf(day)
    const id = SourceId.make(`s${source++}`)
    const before = drafts.length
    const put = (draft: StoredDraft) => drafts.push({ draft, at })
    put(stored(sourceEvent, { id, said: [{ by: "host", text: said.map(sentenceOf).join("\n") }], at, meta: WORLD_META }))
    counts.sources++
    /**
     * The entity a name is: the one the knowledge holds under it or under another name the world means as the same,
     * else one made under the name the world stores it as. A name it is said under that the entity does not bear yet
     * is given it as another name.
     */
    const entityOf = (name: string, kind: string): EntityId => {
      const group = SAME.find((pair) => pair.some((one) => folded(one) === folded(name)))
      const named = group === undefined ? name : group[1]
      const known = Option.firstSomeOf([name, ...(group ?? [])].map((one) => Option.fromNullishOr(byName.get(folded(one)))))
      const found = Option.getOrElse(known, () => EntityId.make(`n${entity++}`))
      if (Option.isNone(known)) {
        put(stored(entityEvent, { id: found, name: named, kind, source: id }))
        counts.entities++
        byName.set(folded(named), found)
        aliasesOf.set(found, new Set([folded(named)]))
      }
      const names = aliasesOf.get(found) ?? new Set<string>()
      if (!names.has(folded(name))) {
        put(stored(aliasedEvent, { id: found, alias: name, source: id }))
        counts.aliases++
        names.add(folded(name))
        aliasesOf.set(found, names)
        byName.set(folded(name), found)
      }
      return found
    }
    for (const entry of said) {
      const [subject, relation, object] = entry
      const text = sentenceOf(entry)
      // Said word for word by a memory that stands, or by one that ended after this day: that memory, said again. The
      // knowledge does not count a restatement of a memory that ended, so it stays ended: what the world said before
      // a conversation changed it does not bring it back.
      const before = endedText.get(folded(text))
      const again = byText.get(folded(text)) ?? (before !== undefined && before.at > at ? before.id : undefined)
      if (again !== undefined) {
        put(stored(memoryRestatedEvent, { id: again, source: id, quote: text }))
        counts.restated++
        continue
      }
      const who = entityOf(subject, subjectKind(subject, relation))
      const what = TO_ENTITY.test(relation) ? Option.some(entityOf(object, objectKind(relation, object))) : Option.none<EntityId>()
      const made = MemoryId.make(`m${memory++}`)
      const about = [...new Set([who, ...Option.toArray(what)])]
      put(stored(memoryEvent, { id: made, kind: memoryKind(relation), text, about, quote: text, by: "host", source: id }))
      counts.memories++
      byText.set(folded(text), made)
      // A later employer or home ends the one the person held, when it is another entity: the same one under another name is no change.
      if (ONE_AT_A_TIME.test(relation) && Option.isSome(what)) {
        const slot = `${who}|${relation}`
        const earlier = holding.get(slot)
        if (earlier === undefined || earlier.entity !== what.value) {
          if (earlier !== undefined) {
            put(stored(memoryEndedEvent, { id: earlier.id, why: "changed", by: made, source: id }))
            counts.ended++
            byText.delete([...byText].find(([, held]) => held === earlier.id)?.[0] ?? "")
          }
          holding.set(slot, { id: made, entity: what.value })
        }
      }
    }
    // The source was read by no model: what was kept is stored, and the source is curated, so no program takes it up.
    put(stored(curatedEvent, { source: id, calls: 0, kept: drafts.length - before - 1, dropped: [] }))
    counts.curated++
  }
  return { drafts, counts }
}

/** Whether the knowledge session holds the world already: a source the world wrote is in it. */
const holdsWorld = (journal: ReadonlyArray<StoredEvent>): boolean =>
  journal.some((record) => Option.exists(dataOf(sourceEvent, record), (source) => source.meta?.written === WORLD_META.written))

/** What a load stored, in words. */
export const storedWords = (counts: WorldCounts): string =>
  `Stored the world's ${WORLD.length} sentences in one turn on the knowledge session: ${counts.memories} memories, ${counts.restated} said again and ${counts.ended} ended, about ${counts.entities} new entities, from ${counts.sources} days, each a source of its own.`

/**
 * Load the world: every sentence of world.ts kept in the knowledge session, in one turn, each record with its day as
 * its time. It is refused, storing nothing, when the knowledge session holds the world already. It gives what it
 * stored in words, or why it stored nothing.
 */
export const loadWorld: Effect.Effect<string, string, Sessions> = Effect.gen(function* () {
  const sessions = yield* Sessions
  const session = yield* knowledgeSession
  // Read first, so a second load opens no turn; read again inside the turn, where nothing else writes.
  if (holdsWorld((yield* sessions.read(session)).events)) return yield* Effect.fail(LOADED_ALREADY)
  const live = yield* Clock.Clock
  return yield* sessions.turn(session, (open) => Effect.gen(function* () {
    const journal = yield* open.journal
    if (holdsWorld(journal)) return Result.fail(LOADED_ALREADY)
    const made = worldDrafts(knowledgeOf(journal))
    // Each record is stamped with its day: the append runs with a clock that reads noon of that day.
    yield* Effect.forEach(made.drafts, ({ draft, at }) => open.append(draft).pipe(Effect.provideService(Clock.Clock, clockAt(at, live))), { concurrency: 1, discard: true })
    return Result.succeed(storedWords(made.counts))
  }))
}).pipe(
  Effect.flatMap(Effect.fromResult),
  Effect.catch((error) => Effect.fail(typeof error === "string" ? error : `The world could not be loaded: ${error.message}`)),
)
