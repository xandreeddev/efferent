import { Match, Option, Schema } from "effect"
import { stored } from "@xandreed/core"
import type { StoredDraft } from "@xandreed/core"
import {
  aliasedEvent, CurationRef, ENTITY_NAME_LIMIT, entityEvent, EntityId, EntityKind, EntityName, MEMORY_LIMIT, MemoryDay, memoryEndedEvent, memoryEvent, MemoryId, MemoryKind,
  memoryRestatedEvent, MemoryText, Quote, QUOTE_LIMIT,
} from "./knowledge.entity.js"
import type { About, Curation, Dropped, Knowledge, KnownEntity, KnownMemory, MemoryData, ReadCuration, ShownKnowledge, SourceId, SourcePart, Staged } from "./knowledge.entity.js"
import { evidenceOf, folded, nextIds, standing } from "./knowledge.entity.functions.js"

/** A text of a reply that says something: a string that is not blank. */
const Text = Schema.String.check(Schema.isPattern(/\S/))
const isText = Schema.is(Text)

/** A value of a reply that should be a list, as one: anything else is a list of nothing. */
const listOf = (value: Schema.Json | undefined): ReadonlyArray<Schema.Json> => (Array.isArray(value) ? value : [])

/** The texts among a list's values, as the names a reply gives things, without the spaces around them. */
const refsOf = (values: ReadonlyArray<Schema.Json>): ReadonlyArray<CurationRef> => values.filter(isText).map((value) => CurationRef.make(value.trim()))

/** A reply's object: its five lists, each read on its own, whatever else it holds. */
const Reply = Schema.fromJsonString(Schema.Struct({
  entities: Schema.optionalKey(Schema.Json),
  aliases: Schema.optionalKey(Schema.Json),
  memories: Schema.optionalKey(Schema.Json),
  restates: Schema.optionalKey(Schema.Json),
  forget: Schema.optionalKey(Schema.Json),
}))
const reply = Schema.decodeUnknownOption(Reply)

/** The least an item of each list must hold to be read: the rest gets a default. */
const entityItem = Schema.decodeUnknownOption(Schema.Struct({ key: Text, name: Text, kind: Schema.optionalKey(Schema.Json) }))
const aliasItem = Schema.decodeUnknownOption(Schema.Struct({ id: Text, alias: Text }))
const memoryItem = Schema.decodeUnknownOption(Schema.Struct({
  text: Text,
  quote: Text,
  about: Schema.Array(Schema.Json),
  kind: Schema.optionalKey(Schema.Json),
  by: Schema.optionalKey(Schema.Json),
  on: Schema.optionalKey(Schema.Json),
  ends: Schema.optionalKey(Schema.Json),
  why: Schema.optionalKey(Schema.Json),
}))
const restateItem = Schema.decodeUnknownOption(Schema.Struct({ id: Text, quote: Schema.optionalKey(Schema.Json) }))

/** The kind an entity gets when a reply names none, or one that is no kind. */
const DEFAULT_ENTITY_KIND = "thing"

/** The kind a memory gets when a reply names none, or one that is no kind. */
const DEFAULT_MEMORY_KIND: MemoryKind = "fact"

/**
 * A curator's reply, read (ADR 0022): the JSON object from the reply's first `{` to its last `}`, so a code fence
 * or words around the object are passed over. None when there is no such object.
 *
 * Each of the five lists is read on its own, item by item: an item of the wrong shape is left out and counted in
 * `malformed`, and the rest of the reply is kept. A list that is missing, or is no list, is empty. What an item may
 * lack gets a default: an entity's kind (`thing`), a memory's kind (`fact`), who said its quote (`user`), what it
 * ends (nothing), its day and its reason (none), a restatement's quote (empty). Names and sentences lose the
 * spaces around them. Nothing is checked beyond the shape: that is `staged`'s.
 *
 * @public
 */
export const curationOf = (text: string): Option.Option<ReadCuration> => {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return Option.none()
  return Option.map(reply(text.slice(start, end + 1)), (object) => {
    let malformed = 0
    const kept = <Item, Made>(values: Schema.Json | undefined, read: (value: Schema.Json) => Option.Option<Item>, make: (item: Item) => Made): ReadonlyArray<Made> =>
      listOf(values).flatMap((value) => Option.match(read(value), {
        onNone: () => {
          malformed += 1
          return []
        },
        onSome: (item) => [make(item)],
      }))
    const curation: Curation = {
      entities: kept(object.entities, entityItem, (item) => ({ key: CurationRef.make(item.key.trim()), name: item.name.trim(), kind: isText(item.kind) ? item.kind.trim() : DEFAULT_ENTITY_KIND })),
      aliases: kept(object.aliases, aliasItem, (item) => ({ id: CurationRef.make(item.id.trim()), alias: item.alias.trim() })),
      memories: kept(object.memories, memoryItem, (item) => ({
        kind: isText(item.kind) ? item.kind.trim() : DEFAULT_MEMORY_KIND,
        text: item.text.trim(),
        about: refsOf(item.about),
        quote: item.quote,
        by: isText(item.by) ? item.by.trim() : "user",
        on: isText(item.on) ? Option.some(item.on.trim()) : Option.none(),
        ends: refsOf(listOf(item.ends)),
        why: isText(item.why) ? Option.some(item.why.trim()) : Option.none(),
      })),
      restates: kept(object.restates, restateItem, (item) => ({ id: CurationRef.make(item.id.trim()), quote: typeof item.quote === "string" ? item.quote : "" })),
      forget: kept(object.forget, (value) => (isText(value) ? Option.some(value) : Option.none()), (value) => CurationRef.make(value.trim())),
    }
    return { curation, malformed }
  })
}

/**
 * Why the checks drop an item, each in one plain sentence: they are stored (`plugin.knowledge.curated`) and reach
 * a page and a log.
 */
export const DROPPED_BECAUSE = {
  entityName: `An entity's name is one line of 1 to ${ENTITY_NAME_LIMIT} characters with a letter or a digit.`,
  entityKey: "Its key is the id of a stored entity.",
  entityKeyTwice: "Its key is the key of another new entity of the same reply.",
  aliasEntity: "No entity the curator was shown has that id.",
  aliasName: `An alias is one line of 1 to ${ENTITY_NAME_LIMIT} characters with a letter or a digit.`,
  memoryText: `A memory is one line of 1 to ${MEMORY_LIMIT} characters.`,
  quoteNotSaid: "Its quote is not in what the user said, a tool returned or the host wrote.",
  quoteLength: `A quote is at most ${QUOTE_LIMIT} characters.`,
  aboutUnknown: "It is about something that is no entity the curator was shown and no new entity of the same reply.",
  aboutMany: "A memory is about at most 8 entities.",
  memoryTwice: "Another memory of the same reply says the same.",
  noStandingMemory: "No standing memory the curator was shown has that id.",
  noCommonEntity: "The two memories are about no common entity.",
} as const

const entityName = Schema.decodeUnknownOption(EntityName)
const entityKind = Schema.decodeUnknownOption(EntityKind)
const memoryText = Schema.decodeUnknownOption(MemoryText)
const memoryKind = Schema.decodeUnknownOption(MemoryKind)
const memoryDay = Schema.decodeUnknownOption(MemoryDay)
const quoteText = Schema.decodeUnknownOption(Quote)

/** A text of the model's as a dropped item repeats it: its start, and how much was left out. */
const shownText = (text: string): string => {
  if (text.length <= 80) return JSON.stringify(text)
  const end = (text.charCodeAt(79) & 0xfc00) === 0xd800 ? 79 : 80
  return `${JSON.stringify(text.slice(0, end))} [… ${text.length - end} characters clipped]`
}

/** Whether an entity bears a name: as its name or as another name of it, compared folded. */
const bears = (entity: KnownEntity, name: string): boolean => folded(name).length > 0 && [entity.name, ...entity.aliases].some((own) => folded(own) === folded(name))

/** A name with a letter or a digit, within an entity name's limits; none for any other text. */
const nameFrom = (text: string): Option.Option<EntityName> => Option.filter(entityName(text.trim()), (name) => folded(name).length > 0)

/**
 * What of a curator's reply is stored (ADR 0022): each item is checked alone, a bad one is dropped with its reason
 * (`dropped`) and the rest is kept. `source` is what the curator read, in parts; `shown` is what it was shown of
 * the knowledge (`shownFor`), and a reply may name nothing else. Pure.
 *
 * - **A new entity** whose name a shown entity bears (compared folded, as a name or as another name) is that
 *   entity, and so is one whose name an earlier new entity of the reply has. Its key then names that entity, unless
 *   the key is another shown entity's id, which goes on naming its own. A name that is not one line of 1 to 80
 *   characters with a letter or a digit is dropped; so is a key that is a shown entity's id, or another new
 *   entity's key. A kind that is no kind becomes `thing`.
 * - **An alias** is kept only for a shown entity, and only when the entity does not bear it yet.
 * - **A memory** is dropped when its sentence is not one line of 1 to 300 characters; when its quote is not found
 *   in one part of what the user said, a tool returned or the host wrote (compared folded; the assistant's words
 *   never count, and neither do a tool call's name and parameters, which the model wrote), or is over 300
 *   characters; when it is about something that is neither a shown entity nor a new one of the reply,
 *   or about more than 8; or when an earlier memory of the reply says the same. Who said it (`by`) is the speaker
 *   of the part that holds the quote, the one the reply named when several do. A memory about nothing is kept.
 *   A sentence a standing shown memory already has becomes a restatement of that memory. A kind that is no kind
 *   becomes `fact`. Its day (`on`) is kept only when it is a day.
 * - **Each end** (`ends`) must name a standing shown memory that shares a stored entity with the new memory; an end
 *   that does not is dropped alone, and the memory is kept. So a memory about nothing ends nothing. The reason is
 *   `changed` unless the reply says `wrong`.
 * - **A restatement** and **a forgetting** are kept only for a standing shown memory, and a restatement needs its
 *   quote found in what was said, as a memory does.
 *
 * @public
 */
export const staged = (curation: Curation, source: { readonly said: ReadonlyArray<SourcePart> }, shown: ShownKnowledge): Staged => {
  const dropped: Array<Dropped> = []
  const drop = (what: string, why: string): void => {
    dropped.push({ what, why })
  }
  const shownEntities = new Map<string, KnownEntity>(shown.entities.map((entity) => [entity.id, entity]))
  const shownStanding = new Map<string, KnownMemory>(shown.memories.filter((memory) => Option.isNone(memory.ended)).map((memory) => [memory.id, memory]))
  const evidence = evidenceOf(source).map((part) => ({ by: part.by, text: folded(part.text) }))
  /** Who said a quote: the speaker of a part that holds it, the one the reply named when several do; none when no part holds it. */
  const saidBy = (quote: string, named: string): Option.Option<MemoryData["by"]> => {
    const wanted = folded(quote)
    const holding = wanted.length === 0 ? [] : evidence.filter((part) => part.text.includes(wanted)).map((part) => part.by)
    return Option.fromNullishOr(holding.find((by) => by === named) ?? holding[0])
  }

  // New entities. One whose name a shown entity bears, or an earlier new one has, is that one.
  const same = new Map<string, About>()
  const entities: Array<Staged["entities"][number]> = []
  for (const proposed of curation.entities) {
    const what = `entity ${shownText(proposed.name)}`
    const known = shown.entities.find((entity) => bears(entity, proposed.name))
    if (known !== undefined) {
      // A key that is another shown entity's id goes on naming that entity, whatever name the reply gave under it.
      const own = shownEntities.get(proposed.key)
      if (own === undefined || own.id === known.id) same.set(proposed.key, { _tag: "Stored", id: known.id })
      continue
    }
    const name = nameFrom(proposed.name)
    if (Option.isNone(name)) {
      drop(what, DROPPED_BECAUSE.entityName)
      continue
    }
    if (shownEntities.has(proposed.key)) {
      drop(what, DROPPED_BECAUSE.entityKey)
      continue
    }
    const twin = entities.find((entity) => folded(entity.name) === folded(name.value))
    if (twin !== undefined) {
      if (twin.key !== proposed.key) same.set(proposed.key, { _tag: "New", key: twin.key })
      continue
    }
    if (entities.some((entity) => entity.key === proposed.key)) {
      drop(what, DROPPED_BECAUSE.entityKeyTwice)
      continue
    }
    entities.push({ key: proposed.key, name: name.value, kind: Option.getOrElse(entityKind(proposed.kind.toLowerCase()), () => DEFAULT_ENTITY_KIND) })
  }
  const made = new Set<string>(entities.map((entity) => entity.key))
  /** What a reply's name stands for: an entity it was merged with, a new entity of the reply, or a shown one. */
  const aboutOf = (ref: CurationRef): Option.Option<About> =>
    Option.orElse(Option.fromNullishOr(same.get(ref)), () =>
      made.has(ref) ? Option.some<About>({ _tag: "New", key: ref })
        : Option.map(Option.fromNullishOr(shownEntities.get(ref)), (entity): About => ({ _tag: "Stored", id: entity.id })))

  // Other names for shown entities.
  const aliases: Array<Staged["aliases"][number]> = []
  for (const proposed of curation.aliases) {
    const what = `alias ${shownText(proposed.alias)} of ${shownText(proposed.id)}`
    const entity = shownEntities.get(proposed.id)
    if (entity === undefined) {
      drop(what, DROPPED_BECAUSE.aliasEntity)
      continue
    }
    const alias = nameFrom(proposed.alias)
    if (Option.isNone(alias)) {
      drop(what, DROPPED_BECAUSE.aliasName)
      continue
    }
    const known = bears(entity, alias.value) || aliases.some((other) => other.id === entity.id && folded(other.alias) === folded(alias.value))
    if (!known) aliases.push({ id: entity.id, alias: alias.value })
  }

  // Stored memories said again.
  const restates = new Map<MemoryId, Quote>()
  for (const proposed of curation.restates) {
    const what = `restatement of ${shownText(proposed.id)}`
    const memory = shownStanding.get(proposed.id)
    if (memory === undefined) {
      drop(what, DROPPED_BECAUSE.noStandingMemory)
      continue
    }
    if (Option.isNone(saidBy(proposed.quote, ""))) {
      drop(what, DROPPED_BECAUSE.quoteNotSaid)
      continue
    }
    const quote = quoteText(proposed.quote)
    if (Option.isNone(quote)) {
      drop(what, DROPPED_BECAUSE.quoteLength)
      continue
    }
    if (!restates.has(memory.id)) restates.set(memory.id, quote.value)
  }

  // New memories, each with the stored memories it ends.
  const memories: Array<Staged["memories"][number]> = []
  const ending = new Set<MemoryId>()
  for (const proposed of curation.memories) {
    const what = `memory ${shownText(proposed.text)}`
    const text = memoryText(proposed.text.trim())
    if (Option.isNone(text)) {
      drop(what, DROPPED_BECAUSE.memoryText)
      continue
    }
    const by = saidBy(proposed.quote, proposed.by)
    if (Option.isNone(by)) {
      drop(what, DROPPED_BECAUSE.quoteNotSaid)
      continue
    }
    const quote = quoteText(proposed.quote)
    if (Option.isNone(quote)) {
      drop(what, DROPPED_BECAUSE.quoteLength)
      continue
    }
    const named = proposed.about.map(aboutOf)
    if (named.some(Option.isNone)) {
      drop(what, DROPPED_BECAUSE.aboutUnknown)
      continue
    }
    const about = named.flatMap((one) => Option.toArray(one)).filter((one, at, all) => all.findIndex((other) => JSON.stringify(other) === JSON.stringify(one)) === at)
    if (about.length > 8) {
      drop(what, DROPPED_BECAUSE.aboutMany)
      continue
    }
    const stands = [...shownStanding.values()].find((memory) => folded(memory.text) === folded(text.value))
    if (stands !== undefined) {
      if (!restates.has(stands.id)) restates.set(stands.id, quote.value)
      continue
    }
    if (memories.some((memory) => folded(memory.text) === folded(text.value))) {
      drop(what, DROPPED_BECAUSE.memoryTwice)
      continue
    }
    const storedAbout = about.flatMap((one): ReadonlyArray<EntityId> => Match.valueTags(one, { Stored: ({ id }) => [id], New: () => [] }))
    const ends = [...new Set(proposed.ends)].flatMap((ref): ReadonlyArray<MemoryId> => {
      const end = `end of ${shownText(ref)} by ${what}`
      const old = shownStanding.get(ref)
      if (old === undefined) {
        drop(end, DROPPED_BECAUSE.noStandingMemory)
        return []
      }
      if (!old.about.some((entity) => storedAbout.includes(entity))) {
        drop(end, DROPPED_BECAUSE.noCommonEntity)
        return []
      }
      if (ending.has(old.id)) return []
      ending.add(old.id)
      return [old.id]
    })
    memories.push({
      kind: Option.getOrElse(memoryKind(proposed.kind.toLowerCase()), () => DEFAULT_MEMORY_KIND),
      text: text.value,
      about,
      quote: quote.value,
      by: by.value,
      on: Option.flatMap(proposed.on, memoryDay),
      ends,
      why: Option.contains(proposed.why, "wrong") ? "wrong" : "changed",
    })
  }

  // Stored memories to forget.
  const forget = [...new Set(curation.forget)].flatMap((ref): ReadonlyArray<MemoryId> => {
    const memory = shownStanding.get(ref)
    if (memory !== undefined) return [memory.id]
    drop(`forgetting of ${shownText(ref)}`, DROPPED_BECAUSE.noStandingMemory)
    return []
  })

  return { entities, aliases, memories, restates: [...restates].map(([id, quote]) => ({ id, quote })), forget, dropped }
}

/**
 * The records to append for a staged curation (ADR 0022), in this order: the new entities; the new names; each
 * memory, followed by a `plugin.knowledge.ended` for each memory it ends (naming it as what came in their place);
 * the restatements; and a `plugin.knowledge.ended` for each memory to forget (`asked`). Every record names
 * `source`. Ids go on from `nextIds(knowledge)`.
 *
 * It is called after the model answered, and the knowledge may have moved in the meantime, so it reads
 * `knowledge` as it stands now, not as the curator was shown it:
 *
 * - a new entity whose name an entity now bears is that entity, and no record is written for it;
 * - a new name an entity now bears is left out;
 * - an end, a restatement or a forgetting of a memory that no longer stands is left out, and so is a second one in
 *   the same curation: a memory ends once.
 *
 * Pure: it appends nothing. The caller stores the drafts in one turn of the knowledge session, after the source's
 * own record.
 *
 * @public
 */
export const draftsOf = (stage: Staged, knowledge: Knowledge, source: { readonly id: SourceId }): ReadonlyArray<StoredDraft> => {
  const next = nextIds(knowledge)
  let entityNumber = Number(next.entity.slice(1))
  let memoryNumber = Number(next.memory.slice(1))
  const made = new Map<string, EntityId>()
  const entities = stage.entities.flatMap((entity): ReadonlyArray<StoredDraft> => {
    const known = knowledge.entities.find((other) => bears(other, entity.name))
    if (known !== undefined) {
      made.set(entity.key, known.id)
      return []
    }
    const id = EntityId.make(`n${entityNumber++}`)
    made.set(entity.key, id)
    return [stored(entityEvent, { id, name: entity.name, kind: entity.kind, source: source.id })]
  })
  const aliases = stage.aliases.flatMap(({ id, alias }): ReadonlyArray<StoredDraft> =>
    knowledge.entities.some((entity) => entity.id === id && !bears(entity, alias)) ? [stored(aliasedEvent, { id, alias, source: source.id })] : [])
  const stands = new Set<MemoryId>(standing(knowledge).map((memory) => memory.id))
  /** A memory that still stands is taken, once: an end or a forgetting of it is written, and no second one. */
  const taken = (id: MemoryId): boolean => stands.delete(id)
  const memories = stage.memories.flatMap((memory): ReadonlyArray<StoredDraft> => {
    const id = MemoryId.make(`m${memoryNumber++}`)
    const about = [...new Set(memory.about.flatMap((one): ReadonlyArray<EntityId> => Match.valueTags(one, {
      Stored: ({ id: entity }) => [entity],
      New: ({ key }) => Option.toArray(Option.fromNullishOr(made.get(key))),
    })))]
    return [
      stored(memoryEvent, { id, kind: memory.kind, text: memory.text, about, quote: memory.quote, by: memory.by, source: source.id, ...Option.match(memory.on, { onNone: () => ({}), onSome: (on) => ({ on }) }) }),
      ...memory.ends.filter(taken).map((old) => stored(memoryEndedEvent, { id: old, why: memory.why, by: id, source: source.id })),
    ]
  })
  const restates = stage.restates.flatMap(({ id, quote }): ReadonlyArray<StoredDraft> => (stands.has(id) ? [stored(memoryRestatedEvent, { id, source: source.id, quote })] : []))
  const forgotten = stage.forget.filter(taken).map((id) => stored(memoryEndedEvent, { id, why: "asked", source: source.id }))
  return [...entities, ...aliases, ...memories, ...restates, ...forgotten]
}
