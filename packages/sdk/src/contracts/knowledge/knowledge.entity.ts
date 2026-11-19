import { Schema } from "effect"
import type { Option } from "effect"
import { SessionId, storedEvent, TurnNumber, vocabularyOf } from "@xandreed/core"
import type { Vocabulary } from "@xandreed/core"

/**
 * A source's name: `s` and a number (`s3`). A source is what a memory rests on: one turn of a conversation, or a
 * text a host wrote. The knowledge session mints it, one more than the number of sources it holds.
 *
 * @public
 */
export const SourceId = Schema.String.check(Schema.isPattern(/^s[1-9][0-9]{0,8}$/)).pipe(Schema.brand("SourceId"))
export type SourceId = typeof SourceId.Type

/**
 * An entity's name as an id: `n` and a number (`n3`), short enough for a model to write back. An entity is a
 * person, a place or any other named thing a memory is about.
 *
 * @public
 */
export const EntityId = Schema.String.check(Schema.isPattern(/^n[1-9][0-9]{0,8}$/)).pipe(Schema.brand("EntityId"))
export type EntityId = typeof EntityId.Type

/**
 * A memory's id: `m` and a number (`m3`). A memory is one sentence that is kept, about entities. An id is never
 * given twice: a memory that ended keeps its id.
 *
 * @public
 */
export const MemoryId = Schema.String.check(Schema.isPattern(/^m[1-9][0-9]{0,8}$/)).pipe(Schema.brand("MemoryId"))
export type MemoryId = typeof MemoryId.Type

/**
 * The entity that stands for the person the memory is kept for. No record stores it: every fold holds it
 * (`knowledgeOf`), and the entities that are stored start at `n2`.
 *
 * @public
 */
export const USER_ENTITY = EntityId.make("n1")

/**
 * What the user's entity is called, in the words the curation prompt uses for it ("the user"). The prompt is the
 * kernel's and is written in English, so this name is too.
 *
 * @public
 */
export const USER_NAME = "the user"

/**
 * The other names the user's entity bears from the start: the words a person uses for themself in a message the
 * curator reads. English, as the curation prompt is.
 *
 * @public
 */
export const USER_ALIASES: ReadonlyArray<string> = ["I", "me"]

/** One line with no space at either end: no character that ends a line is in it. */
const oneLine = /^(?![^]*[\n\r\v\f\u0085\u2028\u2029])\S(?:[^]*\S)?$/

/**
 * The most characters of an entity's name, and of another name it bears (an alias).
 *
 * @public
 */
export const ENTITY_NAME_LIMIT = 80

/**
 * An entity's name, or an alias of it: one line of 1 to `ENTITY_NAME_LIMIT` characters, with no space at either
 * end. One line, since entities are listed to a model a line each.
 *
 * @public
 */
export const EntityName = Schema.String.check(Schema.isPattern(oneLine), Schema.isMaxLength(ENTITY_NAME_LIMIT))
export type EntityName = typeof EntityName.Type

/**
 * What kind of thing an entity is: one word of 1 to 20 letters, none of them a capital. The curation prompt offers
 * `ENTITY_KINDS`; a host may give a list of its own.
 *
 * @public
 */
export const EntityKind = Schema.String.check(Schema.isPattern(/^[\p{Ll}\p{Lo}]{1,20}$/u))
export type EntityKind = typeof EntityKind.Type

/**
 * The kinds of entity the curation prompt offers unless a host gives its own. The last, `thing`, is also the kind
 * an entity gets when a curator's reply names none, or one that is no kind.
 *
 * @public
 */
export const ENTITY_KINDS: ReadonlyArray<string> = ["person", "organization", "place", "project", "thing"]

/**
 * The most characters of a memory's sentence.
 *
 * @public
 */
export const MEMORY_LIMIT = 300

/**
 * What a memory says: one line of 1 to `MEMORY_LIMIT` characters, with no space at either end. A longer one is
 * dropped by the checks, never cut: a cut sentence says something else.
 *
 * @public
 */
export const MemoryText = Schema.String.check(Schema.isPattern(oneLine), Schema.isMaxLength(MEMORY_LIMIT))
export type MemoryText = typeof MemoryText.Type

/**
 * What a memory is: a `fact`, a `preference`, a `decision`, a `goal`, an `event` (something that happened or will
 * happen on a day) or a line of the user's `profile` (a name, a job).
 *
 * @public
 */
export const MemoryKind = Schema.Literals(["fact", "preference", "decision", "goal", "event", "profile"])
export type MemoryKind = typeof MemoryKind.Type

/**
 * The most characters of a quote.
 *
 * @public
 */
export const QUOTE_LIMIT = 300

/**
 * The words of a source that a memory rests on, copied from it: 1 to `QUOTE_LIMIT` characters. It may hold line
 * ends, since a tool's result does.
 *
 * @public
 */
export const Quote = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(QUOTE_LIMIT))
export type Quote = typeof Quote.Type

/**
 * The most characters of a source's text: of one of its parts, and of all its parts as a curator reads them
 * (`sourceText`).
 *
 * @public
 */
export const SOURCE_LIMIT = 24_000

/**
 * The text of one part of a source, and of a tool call as it is shown: 1 to `SOURCE_LIMIT` characters.
 *
 * @public
 */
export const SourceText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(SOURCE_LIMIT))
export type SourceText = typeof SourceText.Type

/**
 * The most characters of a source's context.
 *
 * @public
 */
export const CONTEXT_LIMIT = 4_000

/**
 * What came before a source, kept only so a curator can tell who and what the source means ("she", "there"): 0 to
 * `CONTEXT_LIMIT` characters. No memory rests on it.
 *
 * @public
 */
export const SourceContext = Schema.String.check(Schema.isMaxLength(CONTEXT_LIMIT))
export type SourceContext = typeof SourceContext.Type

/**
 * The day or the month an event is on: `YYYY-MM-DD`, or `YYYY-MM` when only the month is known.
 *
 * @public
 */
export const MemoryDay = Schema.String.check(Schema.isPattern(/^[0-9]{4}-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12][0-9]|3[01]))?$/))
export type MemoryDay = typeof MemoryDay.Type

/**
 * Who said a part of a source: the `user`, a `tool` (what it returned), the `assistant` (the model's answer) or the
 * `host` (a text the host wrote itself: a decision it recorded, a note).
 *
 * @public
 */
export const SaidBy = Schema.Literals(["user", "tool", "assistant", "host"])
export type SaidBy = typeof SaidBy.Type

/**
 * The call a tool's part is the result of, as a curator reads it: `text`, its name and its parameters
 * (`lookupOrder, called with {"order":"QX-1"}`), and whether the call failed. The model wrote the parameters, so
 * they are shown and no memory may rest on them.
 *
 * @public
 */
export const SourceCall = Schema.Struct({ text: SourceText, failed: Schema.Boolean })
export type SourceCall = typeof SourceCall.Type

/**
 * One part of a source: who said it, and its text. The checks read the parts, so they can tell the user's, a
 * tool's and the host's words from the assistant's.
 *
 * A tool's part holds what the tool returned as its `text` (it may be empty), and may name the call it answers
 * (`call`). A memory may rest on the text, never on the call.
 *
 * @public
 */
export const SourcePart = Schema.Union([
  Schema.Struct({ by: Schema.Literals(["user", "assistant", "host"]), text: SourceText }),
  Schema.Struct({ by: Schema.Literal("tool"), text: Schema.String.check(Schema.isMaxLength(SOURCE_LIMIT)), call: Schema.optionalKey(SourceCall) }),
])
export type SourcePart = typeof SourcePart.Type

/**
 * The data of `plugin.knowledge.source`: what was said, in parts (one or more); `context`, what came before it;
 * `at`, when what it holds happened, in milliseconds (the record's own `at` is when it was stored); `from`, the
 * conversation and turn it is, when it is a turn; and `meta`, a host's own words about it. The text a curator
 * reads is made from the parts (`sourceText`) and is never stored beside them.
 *
 * @public
 */
export const SourceData = Schema.Struct({
  id: SourceId,
  said: Schema.NonEmptyArray(SourcePart),
  context: Schema.optionalKey(SourceContext),
  at: Schema.Finite,
  from: Schema.optionalKey(Schema.Struct({ session: SessionId, turn: TurnNumber })),
  meta: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
})
export type SourceData = typeof SourceData.Type

/**
 * `plugin.knowledge.source`: something was said that memories may rest on (ADR 0022). Stored in the knowledge
 * session, a journal of its own, tagged `memory`, not skippable: every other record of the session names a source.
 *
 * @public
 */
export const sourceEvent = storedEvent("knowledge", "source", { data: SourceData, skippable: false, tags: ["memory"] })

/**
 * The data of `plugin.knowledge.entity`: a new entity, its name and kind, and the source that first named it.
 *
 * @public
 */
export const EntityData = Schema.Struct({ id: EntityId, name: EntityName, kind: EntityKind, source: SourceId })
export type EntityData = typeof EntityData.Type

/**
 * `plugin.knowledge.entity`: an entity was made. Tagged `memory`, not skippable: memories name it by its id.
 *
 * @public
 */
export const entityEvent = storedEvent("knowledge", "entity", { data: EntityData, skippable: false, tags: ["memory"] })

/**
 * The data of `plugin.knowledge.aliased`: another name an entity bears (a spelling, a short form), and the source
 * that used it.
 *
 * @public
 */
export const AliasedData = Schema.Struct({ id: EntityId, alias: EntityName, source: SourceId })
export type AliasedData = typeof AliasedData.Type

/**
 * `plugin.knowledge.aliased`: an entity was called by another name. Tagged `memory`, skippable: a reader that does
 * not know it reads the same entities and memories, and only finds an entity by fewer names.
 *
 * @public
 */
export const aliasedEvent = storedEvent("knowledge", "aliased", { data: AliasedData, skippable: true, tags: ["memory"] })

/**
 * The data of `plugin.knowledge.memory`: a memory's sentence, its kind, the entities it is about (none to eight),
 * the quote it rests on and who said the quote (never the assistant), the source the quote is from, and, for an
 * event, its day.
 *
 * @public
 */
export const MemoryData = Schema.Struct({
  id: MemoryId,
  kind: MemoryKind,
  text: MemoryText,
  about: Schema.Array(EntityId).check(Schema.isMaxLength(8)),
  quote: Quote,
  by: Schema.Literals(["user", "tool", "host"]),
  source: SourceId,
  on: Schema.optionalKey(MemoryDay),
})
export type MemoryData = typeof MemoryData.Type

/**
 * `plugin.knowledge.memory`: a memory was written. Tagged `memory`, not skippable.
 *
 * @public
 */
export const memoryEvent = storedEvent("knowledge", "memory", { data: MemoryData, skippable: false, tags: ["memory"] })

/**
 * The data of `plugin.knowledge.restated`: a standing memory said again, the source that said it and the words
 * that did.
 *
 * @public
 */
export const MemoryRestatedData = Schema.Struct({ id: MemoryId, source: SourceId, quote: Quote })
export type MemoryRestatedData = typeof MemoryRestatedData.Type

/**
 * `plugin.knowledge.restated`: a memory that stands was said again. Tagged `memory`, skippable: a reader that does
 * not know it reads the same memories, without how often and when each was said.
 *
 * @public
 */
export const memoryRestatedEvent = storedEvent("knowledge", "restated", { data: MemoryRestatedData, skippable: true, tags: ["memory"] })

/**
 * Why a memory ended: the world `changed`, the memory was `wrong` from the start, or the user `asked` for it to be
 * forgotten.
 *
 * @public
 */
export const EndedWhy = Schema.Literals(["changed", "wrong", "asked"])
export type EndedWhy = typeof EndedWhy.Type

/**
 * The data of `plugin.knowledge.ended`: the memory that no longer stands, why, the memory that replaced it (`by`,
 * when one did), and the source that said so.
 *
 * @public
 */
export const MemoryEndedData = Schema.Struct({ id: MemoryId, why: EndedWhy, by: Schema.optionalKey(MemoryId), source: SourceId })
export type MemoryEndedData = typeof MemoryEndedData.Type

/**
 * `plugin.knowledge.ended`: a memory no longer stands. Nothing is deleted: the memory's record stays, and this one
 * says when and why it ended. Tagged `memory`, not skippable: a reader that passed over it would go on giving a
 * memory that ended.
 *
 * @public
 */
export const memoryEndedEvent = storedEvent("knowledge", "ended", { data: MemoryEndedData, skippable: false, tags: ["memory"] })

/**
 * The most items a `plugin.knowledge.curated` record lists as dropped.
 *
 * @public
 */
export const DROPPED_SHOWN = 20

/**
 * Something a curator proposed that the checks did not store: what it was, and why, each a plain sentence of at
 * most 300 characters.
 *
 * @public
 */
export const Dropped = Schema.Struct({ what: Schema.String.check(Schema.isMaxLength(300)), why: Schema.String.check(Schema.isMaxLength(300)) })
export type Dropped = typeof Dropped.Type

/**
 * The data of `plugin.knowledge.curated`: the source that was curated, how many model calls it took, how many
 * records were kept, and what the checks dropped (at most `DROPPED_SHOWN`).
 *
 * @public
 */
export const CuratedData = Schema.Struct({
  source: SourceId,
  calls: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  kept: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  dropped: Schema.Array(Dropped).check(Schema.isMaxLength(DROPPED_SHOWN)),
})
export type CuratedData = typeof CuratedData.Type

/**
 * `plugin.knowledge.curated`: a source was read by a curator and what it gave was stored. Tagged `memory`, not
 * skippable: a reader that passed over it would take the source for one still waiting.
 *
 * @public
 */
export const curatedEvent = storedEvent("knowledge", "curated", { data: CuratedData, skippable: false, tags: ["memory"] })

/**
 * The data of `plugin.knowledge.failed`: the source a curation failed for, which try it was (from 1), and why, in
 * words.
 *
 * @public
 */
export const CurationFailedData = Schema.Struct({ source: SourceId, attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)), reason: Schema.String })
export type CurationFailedData = typeof CurationFailedData.Type

/**
 * `plugin.knowledge.failed`: a try at curating a source failed. Tagged `memory`, not skippable: how often a source
 * failed decides whether it is tried again.
 *
 * @public
 */
export const curationFailedEvent = storedEvent("knowledge", "failed", { data: CurationFailedData, skippable: false, tags: ["memory"] })

/**
 * The owner of the knowledge session: the journal that holds what a curator keeps.
 *
 * @public
 */
export const KNOWLEDGE_OWNER = "plugin.knowledge"

/**
 * The vocabulary of the knowledge session: core's own records and the eight of this contract. A journal read with
 * it (`readJournal`) passes over a skippable record it does not know and refuses any other.
 *
 * @public
 */
export const KNOWLEDGE_VOCABULARY: Vocabulary = vocabularyOf("knowledge", [
  sourceEvent, entityEvent, aliasedEvent, memoryEvent, memoryRestatedEvent, memoryEndedEvent, curatedEvent, curationFailedEvent,
])

/**
 * The version of the curation prompt and the review prompt. It goes up when their words or their shape change, so
 * a host can tell which prompt wrote a memory, and an eval which prompt it measured.
 *
 * @public
 */
export const KNOWLEDGE_PROMPT = 1

/**
 * The version of the checks a curator's reply passes before it is stored (`staged`, `draftsOf`). It goes up when
 * a check is added, removed or changed.
 *
 * @public
 */
export const KNOWLEDGE_CHECKS = 1

/**
 * Where a source stands: `Pending` (no curator read it yet), `Curated` (one did, and what it gave is stored), or
 * `Failed` (every try so far failed: how many, and why the last did).
 *
 * @public
 */
export const SourceState = Schema.Union([
  Schema.TaggedStruct("Pending", {}),
  Schema.TaggedStruct("Curated", {}),
  Schema.TaggedStruct("Failed", { attempts: Schema.Int, reason: Schema.String }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type SourceState = typeof SourceState.Type

/**
 * An entity as `knowledgeOf` gives it: its id, name and kind, the other names it bears (each once), and the source
 * that first named it (none for the user's entity, which no record stores).
 *
 * @public
 */
export interface KnownEntity {
  readonly id: EntityId
  readonly name: string
  readonly kind: string
  readonly aliases: ReadonlyArray<string>
  readonly source: Option.Option<SourceId>
}

/**
 * How a memory ended: when, in milliseconds (the `at` of the source that ended it: when that was said, not when
 * its record was stored), why, and the memory that replaced it, when one did.
 *
 * @public
 */
export interface Ended {
  readonly at: number
  readonly why: EndedWhy
  readonly by: Option.Option<MemoryId>
}

/**
 * A memory as `knowledgeOf` gives it: the data of its record, with how often it was said (`count`: 1, and one more
 * for each `plugin.knowledge.restated`), when it was first and last said (`first`, `last`: the earliest and the
 * latest `at` of the sources that said it, in milliseconds, so when it was said and not when a record was stored),
 * the sources that said it, each once, and how it ended, if it did. A memory that ended stays in the list.
 *
 * @public
 */
export interface KnownMemory {
  readonly id: MemoryId
  readonly kind: MemoryKind
  readonly text: MemoryText
  readonly about: ReadonlyArray<EntityId>
  readonly quote: Quote
  readonly by: MemoryData["by"]
  readonly on: Option.Option<MemoryDay>
  readonly count: number
  readonly first: number
  readonly last: number
  readonly sources: ReadonlyArray<SourceId>
  readonly ended: Option.Option<Ended>
}

/**
 * A source as `knowledgeOf` gives it: the data of its record, when the record was stored (`stored`, in
 * milliseconds), and where it stands (`SourceState`).
 *
 * @public
 */
export interface KnownSource {
  readonly source: SourceData
  readonly stored: number
  readonly state: SourceState
}

/**
 * What a knowledge session's journal holds, as `knowledgeOf` folds it: the entities (the user's first), every
 * memory in the order written, and every source with its state.
 *
 * @public
 */
export interface Knowledge {
  readonly entities: ReadonlyArray<KnownEntity>
  readonly memories: ReadonlyArray<KnownMemory>
  readonly sources: ReadonlyArray<KnownSource>
}

/**
 * The ids the next source, entity and memory take (`nextIds`).
 *
 * @public
 */
export interface NextIds {
  readonly source: SourceId
  readonly entity: EntityId
  readonly memory: MemoryId
}

/**
 * At most how much a curator is shown (`shownFor`): how many entities the source or its context names, how many
 * memories for each of them, and how many memories in all.
 *
 * @public
 */
export interface ShownLimits {
  readonly entities: number
  readonly each: number
  readonly memories: number
}

/**
 * How much a curator is shown unless a host says otherwise: ten entities, thirty memories for each, forty in all.
 *
 * @public
 */
export const SHOWN_LIMITS: ShownLimits = { entities: 10, each: 30, memories: 40 }

/**
 * What a curator is shown of the knowledge for one source (`shownFor`): the entities and the memories that may
 * relate to it. A curator's reply may name nothing else.
 *
 * @public
 */
export interface ShownKnowledge {
  readonly entities: ReadonlyArray<KnownEntity>
  readonly memories: ReadonlyArray<KnownMemory>
}

/**
 * A turn of a conversation as a source (`turnSource`): its parts, each with who said it; `text`, the parts as a
 * curator reads them; and `context`, the two turns before it.
 *
 * @public
 */
export interface TurnSource {
  readonly text: string
  readonly context: string
  readonly said: readonly [SourcePart, ...Array<SourcePart>]
}

/**
 * The most characters `turnSource` keeps of one message of the user's, and of the turn's answer.
 *
 * @public
 */
export const TURN_MESSAGE_SHOWN = 8_000

/**
 * The most characters `turnSource` keeps of one tool call's parameters, and of its result, each.
 *
 * @public
 */
export const TURN_RESULT_SHOWN = 4_000

/**
 * The options of `turnSource`: `leave` names tools whose calls are left out of the source (a tool that reads the
 * memory itself, whose result is no news).
 *
 * @public
 */
export interface TurnSourceOptions {
  readonly leave?: ReadonlyArray<string>
}

/**
 * The options of `curationPrompt`: `kinds`, the kinds of entity it offers (`ENTITY_KINDS` unless given), and
 * `instructions`, a line of the host's own, added after the rules.
 *
 * @public
 */
export interface CurationOptions {
  readonly kinds?: ReadonlyArray<string>
  readonly instructions?: string
}

/**
 * A name a curator's reply gives a thing: a stored id (`n3`, `m5`), or a key of its own for an entity it proposes
 * (`a`). It is the model's text, not blank; whether it names anything is for the checks to say (`staged`).
 *
 * @public
 */
export const CurationRef = Schema.String.check(Schema.isPattern(/\S/)).pipe(Schema.brand("CurationRef"))
export type CurationRef = typeof CurationRef.Type

/**
 * A curator's reply, read (`curationOf`): the entities it proposes, each under a key of its own; other names for
 * stored entities; the memories to write, each with what it is about, the quote it rests on, the day it is on,
 * the stored memories it ends and why; the stored memories said again; and the stored memories to forget. Nothing
 * in it is checked yet: every text is the model's.
 *
 * @public
 */
export const Curation = Schema.Struct({
  entities: Schema.Array(Schema.Struct({ key: CurationRef, name: Schema.String, kind: Schema.String })),
  aliases: Schema.Array(Schema.Struct({ id: CurationRef, alias: Schema.String })),
  memories: Schema.Array(Schema.Struct({
    kind: Schema.String,
    text: Schema.String,
    about: Schema.Array(CurationRef),
    quote: Schema.String,
    by: Schema.String,
    on: Schema.OptionFromNullOr(Schema.String),
    ends: Schema.Array(CurationRef),
    why: Schema.OptionFromNullOr(Schema.String),
  })),
  restates: Schema.Array(Schema.Struct({ id: CurationRef, quote: Schema.String })),
  forget: Schema.Array(CurationRef),
})
export type Curation = typeof Curation.Type

/**
 * A curator's reply as read: the curation, and how many items had the wrong shape and were left out.
 *
 * @public
 */
export interface ReadCuration {
  readonly curation: Curation
  readonly malformed: number
}

/**
 * What a staged memory is about: a stored entity by its id, or an entity the same reply proposes, by its key.
 *
 * @public
 */
export type About = { readonly _tag: "Stored"; readonly id: EntityId } | { readonly _tag: "New"; readonly key: CurationRef }

/**
 * What of a curator's reply passed the checks (`staged`), ready to be stored (`draftsOf`): new entities, each
 * under the reply's key; new names for stored entities; memories, each with the stored memories it ends; stored
 * memories said again; stored memories to forget; and `dropped`, each item the checks left out, with why.
 *
 * @public
 */
export interface Staged {
  readonly entities: ReadonlyArray<{ readonly key: CurationRef; readonly name: EntityName; readonly kind: EntityKind }>
  readonly aliases: ReadonlyArray<{ readonly id: EntityId; readonly alias: EntityName }>
  readonly memories: ReadonlyArray<{
    readonly kind: MemoryKind
    readonly text: MemoryText
    readonly about: ReadonlyArray<About>
    readonly quote: Quote
    readonly by: MemoryData["by"]
    readonly on: Option.Option<MemoryDay>
    readonly ends: ReadonlyArray<MemoryId>
    readonly why: "changed" | "wrong"
  }>
  readonly restates: ReadonlyArray<{ readonly id: MemoryId; readonly quote: Quote }>
  readonly forget: ReadonlyArray<MemoryId>
  readonly dropped: ReadonlyArray<Dropped>
}

/**
 * A source a host hands the curation step (`curate`): what `plugin.knowledge.source` holds but its id, which the
 * knowledge session mints when it stores the source.
 *
 * @public
 */
export type NewSource = Omit<SourceData, "id">

/**
 * The options of the curation step (`curate`, `curateAgain`): whether a second call reviews the first one's reply
 * (`review`, on unless `false`: measured on 40 scripted turns, 39 of 40 right with it against 36 without, ADR 0022),
 * and the prompt's own options (`prompt`: the kinds of entity it offers, a line of the host's own).
 *
 * @public
 */
export interface CurateOptions {
  readonly review?: boolean
  readonly prompt?: CurationOptions
}

/**
 * What a curation stored for one source, as the knowledge session's journal holds it (`keptFrom`): the entities it
 * made, the other names it gave stored ones, the memories it wrote, the memories it said again and those it ended
 * (an end of a memory it wrote names it in `by`; a forgetting is `asked`), its `plugin.knowledge.curated` record when
 * one is stored, and each `plugin.knowledge.failed` of the source, in the order stored.
 *
 * @public
 */
export interface KeptRecords {
  readonly entities: ReadonlyArray<EntityData>
  readonly aliases: ReadonlyArray<AliasedData>
  readonly memories: ReadonlyArray<MemoryData>
  readonly restated: ReadonlyArray<MemoryRestatedData>
  readonly ended: ReadonlyArray<MemoryEndedData>
  readonly curated: Option.Option<CuratedData>
  readonly failed: ReadonlyArray<CurationFailedData>
}

/**
 * What the curation step asked the curator and what it answered: the prompts in the order sent (the curation prompt,
 * then the review prompt when one was sent), and a reply for each call that answered.
 *
 * @public
 */
export interface CurationCalls {
  readonly prompts: ReadonlyArray<string>
  readonly replies: ReadonlyArray<string>
}

/**
 * What the curation step came to for one source (`curate`): `Curated`, with what the curator was shown, how many
 * items of the reply it read had the wrong shape, what the checks dropped (all of it; the stored record keeps the
 * first `DROPPED_SHOWN`) and what was stored; or `Failed`, a `plugin.knowledge.failed` stored with the try and the
 * reason. Either way the source, the try and the calls made. A source whose curation was interrupted gets neither,
 * and stays `Pending`.
 *
 * @public
 */
export type CurationOutcome =
  | {
    readonly _tag: "Curated"
    readonly source: SourceData
    readonly attempt: number
    readonly calls: CurationCalls
    readonly shown: ShownKnowledge
    readonly malformed: number
    readonly dropped: ReadonlyArray<Dropped>
    readonly kept: KeptRecords
  }
  | {
    readonly _tag: "Failed"
    readonly source: SourceData
    readonly attempt: number
    readonly calls: CurationCalls
    readonly reason: string
  }

/**
 * Why a curation's try failed when the curator answered: its reply, or the review's, held no JSON object. A failed
 * call's own reason is the curator's (`CurationFailed`'s message).
 *
 * @public
 */
export const NOT_CURATED = {
  reply: "The curator's reply holds no JSON object.",
  review: "The review's reply holds no JSON object.",
} as const
