import { Option, Schema } from "effect"
import { liveEvent } from "@xandreed/core/kernel"
import { EntityId, MemoryId } from "./knowledge.entity.js"
import type { KnownMemory } from "./knowledge.entity.js"

/**
 * The options of `withKnowledge` (ADR 0023), each with a default:
 *
 * - `limit`: the places for what the fused list ranks first, a whole number from 1 to 50 (8);
 * - `walk`: how many more places the walk by subject may add on top of them, a whole number from 0 to 10 (3);
 * - `speaker`: the words with which a person names themself in a message (`["i", "me", "my"]` in English), each one
 *   word, so a message that holds one is about the user's entity (none: the kernel holds no words of a language);
 * - `stopWords`: words the keyword ranking passes over (`"the"`, `"in"`), each one word (none).
 *
 * @public
 */
export interface KnowledgeOptions {
  readonly limit?: number
  readonly walk?: number
  readonly speaker?: ReadonlyArray<string>
  readonly stopWords?: ReadonlyArray<string>
}

/**
 * `withKnowledge`'s options with every default filled in: what `checkedKnowledgeOptions` gives.
 *
 * @public
 */
export interface KnowledgeRecallOptions {
  readonly limit: number
  readonly walk: number
  readonly speaker: ReadonlyArray<string>
  readonly stopWords: ReadonlyArray<string>
}

/**
 * The options `withKnowledge` runs with when it is given none: eight places, a walk of three more, no speaker's
 * words and no stop words.
 *
 * @public
 */
export const KNOWLEDGE_RECALL: KnowledgeRecallOptions = { limit: 8, walk: 3, speaker: [], stopWords: [] }

/**
 * The weight of each list in the fusion by rank (ADR 0025): a memory at place `p` (from 0) of a list adds
 * `weight / (10 + p)`. `seed` is the list of the memories about a seed, `words` the list the message's words reach,
 * `meaning` the list ranked by meaning. A weight of 0 turns its list off: it is not made, and adds nothing.
 *
 * @public
 */
export interface RecallWeights {
  readonly seed: number
  readonly words: number
  readonly meaning: number
}

/**
 * The weights recall by words runs with (ADR 0023): the list about a seed 1, the words' 0.5, and no list by meaning.
 *
 * @public
 */
export const WORDS_WEIGHTS: RecallWeights = { seed: 1, words: 0.5, meaning: 0 }

/**
 * The options of `withKnowledgeByMeaning` (ADR 0025): those of `withKnowledge`, and
 *
 * - `pool`: how many texts the list by meaning ranks, the nearest to the last message, a whole number from 1 to 100
 *   (50);
 * - `weights`: the weight of each list in the fusion (`RecallWeights`), each a number from 0 to 10, 0 turning a list
 *   off, at least one above 0; a weight left out keeps its default (seed 1, words 0.5, meaning 1.5);
 * - `floor`: the least cosine a text needs to be in the list by meaning, a number from 0 to 1 (none: every text the
 *   search finds is in it). A floor is a number of one embedder's: no default carries between two (ADR 0025).
 *
 * @public
 */
export interface MeaningOptions extends KnowledgeOptions {
  readonly pool?: number
  readonly weights?: Partial<RecallWeights>
  readonly floor?: number
}

/**
 * `withKnowledgeByMeaning`'s options with every default filled in: what `checkedMeaningOptions` gives.
 *
 * @public
 */
export interface MeaningRecallOptions extends KnowledgeRecallOptions {
  readonly pool: number
  readonly weights: RecallWeights
  readonly floor: Option.Option<number>
}

/**
 * The options `withKnowledgeByMeaning` runs with when it is given none: those of `withKnowledge`, a pool of 50, the
 * weights 1 for the list about a seed, 0.5 for the words' and 1.5 for the list by meaning (measured in ADR 0025), and
 * no floor.
 *
 * @public
 */
export const KNOWLEDGE_BY_MEANING: MeaningRecallOptions = { ...KNOWLEDGE_RECALL, pool: 50, weights: { seed: 1, words: 0.5, meaning: 1.5 }, floor: Option.none() }

/**
 * The most characters of an embedder's failure that `plugin.knowledge.recalled` repeats when the list by meaning was
 * skipped for it.
 *
 * @public
 */
export const SKIPPED_SHOWN = 300

/**
 * The most characters of an embedder's model name that keys a memory's vector (ADR 0025): a key is the model, a line
 * feed and the memory's text (at most `MEMORY_LIMIT`, 300), within the vector store's `KEY_LIMIT` (400), whole.
 *
 * @public
 */
export const MEANING_MODEL_LIMIT = 99

/**
 * A text the list by meaning found (ADR 0025): a memory's text the vector store found nearest the last message, with
 * their cosine. One text can be the text of several memories: each is found by it.
 *
 * @public
 */
export interface FoundText {
  readonly text: string
  readonly cosine: number
}

/**
 * What recall by meaning brings to `recallKnowledge` (ADR 0025): the embedder's model, the pool, the weights and the
 * floor it ran with, why the list was skipped when the embedder failed (`skipped`, its words), and the texts found,
 * nearest first (none when the list was off or skipped, nothing was asked, or nothing could be found). A text under
 * the floor is left out of the list by `recallKnowledge`.
 *
 * @public
 */
export interface ByMeaning {
  readonly model: string
  readonly pool: number
  readonly weights: RecallWeights
  readonly floor: Option.Option<number>
  readonly skipped: Option.Option<string>
  readonly found: ReadonlyArray<FoundText>
}

/**
 * A standing memory's place (from 1) in the list by meaning, the memory that took it (the standing one itself, or one
 * it replaced that was found in its stead), and that memory's cosine to the last message.
 *
 * @public
 */
export interface MeaningPlace {
  readonly place: number
  readonly by: KnownMemory
  readonly cosine: number
}

/**
 * What a conversation asks, as recall reads it (`askedOf`): the person's last message (`last`, the memory contract's
 * `questionOf`), and the turn before the one that holds it: the person's messages in it (`user`) and its final answer
 * (`answer`), each empty when there is none.
 *
 * @public
 */
export interface Asked {
  readonly last: string
  readonly before: { readonly user: string; readonly answer: string }
}

/**
 * How a seed was named: by its name or another name it bears in the last message (`name`), by one of the speaker's
 * words there (`speaker`: the user's entity), by its first name there, a person's, when the message named nobody in
 * full and held no speaker's word (`first-name`), or by its name in the turn before, when the last message named
 * nothing (`before`).
 *
 * @public
 */
export const SeedWay = Schema.Literals(["name", "speaker", "first-name", "before"])
export type SeedWay = typeof SeedWay.Type

/**
 * An entity recall starts from: its id and name, how it was named, and the word or name that named it, as stored.
 *
 * @public
 */
export interface Seed {
  readonly id: EntityId
  readonly name: string
  readonly by: SeedWay
  readonly word: string
}

/**
 * What the keyword ranking made of a memory: its BM25 score for the last message's words, and the words of the
 * message it holds, folded. A score of 0 holds none.
 *
 * @public
 */
export interface ScoredMemory {
  readonly memory: KnownMemory
  readonly score: number
  readonly terms: ReadonlyArray<string>
}

/**
 * A standing memory's place (from 1) in one of the two lists, and the memory that took it: the standing one itself,
 * or one it replaced that ranked there in its stead (`by`, with that memory's score and words).
 *
 * @public
 */
export interface ListPlace {
  readonly place: number
  readonly by: ScoredMemory
}

/**
 * A memory of the fused list, which stands: how it was scored, its place in the list of memories about a seed, in
 * the list the message's words reach and in the list by meaning, when it is in them, and its fused score.
 *
 * @public
 */
export interface FusedMemory extends ScoredMemory {
  readonly seed: Option.Option<ListPlace>
  readonly words: Option.Option<ListPlace>
  readonly meaning: Option.Option<MeaningPlace>
  readonly fused: number
}

/**
 * A memory the walk by subject found: how it was scored, and the entity it was found by, its first `about`.
 *
 * @public
 */
export interface WalkedMemory extends ScoredMemory {
  readonly from: EntityId
}

/**
 * An entity the walk by subject starts from: one the three best memories about a seed are about, which the last
 * message did not name, and the first of those memories that brought it in.
 *
 * @public
 */
export interface Bridge {
  readonly id: EntityId
  readonly name: string
  readonly from: MemoryId
}

/**
 * A memory a request is sent, in the order sent: ranked first by the fused list (`ranked`) or added by the walk
 * (`walked`), with the memories it replaced, newest first, each sent under it as what was true before.
 *
 * @public
 */
export interface SentMemory {
  readonly memory: KnownMemory
  readonly why: "ranked" | "walked"
  readonly before: ReadonlyArray<KnownMemory>
}

/**
 * What recall did for one request (`recallKnowledge`): what was asked, the weights of the lists, the embedder's model
 * and the pool when a list by meaning was given, the seeds, the fused list, best first, all of it; the entities the walk started from; every memory it could have taken, best first, all of them; and what is
 * sent, in order.
 *
 * @public
 */
export interface KnowledgeRecall {
  readonly asked: Asked
  readonly weights: RecallWeights
  readonly meaning: Option.Option<{ readonly model: string; readonly pool: number; readonly floor: Option.Option<number>; readonly skipped: Option.Option<string> }>
  readonly seeds: ReadonlyArray<Seed>
  readonly ranked: ReadonlyArray<FusedMemory>
  readonly bridges: ReadonlyArray<Bridge>
  readonly walked: ReadonlyArray<WalkedMemory>
  readonly sent: ReadonlyArray<SentMemory>
}

/**
 * The most memories a memory sent carries as what it replaced ("before that" lines), the newest first: a fact that
 * changes often does not grow every note.
 *
 * @public
 */
export const BEFORE_SHOWN = 3

/**
 * The most memories a `plugin.knowledge.recalled` event lists: those sent first, so it never leaves one out; the rest
 * it counts in `more`.
 *
 * @public
 */
export const KNOWLEDGE_SHOWN = 100

/**
 * The most characters of the last message and of each part of the turn before that a `plugin.knowledge.recalled`
 * event repeats.
 *
 * @public
 */
export const ASKED_SHOWN = 500

/**
 * Why a memory of a `plugin.knowledge.recalled` event was sent, or was not: among the first `limit` of the fused
 * list (`ranked`), added by the walk by subject (`walked`), past the limit (`past-limit`), or past the walk's places
 * (`past-walk`).
 *
 * @public
 */
export const RecalledWhy = Schema.Literals(["ranked", "walked", "past-limit", "past-walk"])
export type RecalledWhy = typeof RecalledWhy.Type

/**
 * The data of `plugin.knowledge.recalled`: what `withKnowledge` or `withKnowledgeByMeaning` did for one request (ADRs
 * 0023 and 0025). What was asked (each text at most `ASKED_SHOWN` characters, what was cut counted); the options it
 * ran with, the weights of the lists among them; the embedder's model, the pool and the floor (`null` for none), when
 * it ranked by meaning (else `null`), and, when the embedder failed and the list by meaning was skipped, why (its
 * words, at most `SKIPPED_SHOWN` characters; else `null`); the seeds, each with how it
 * was named; the entities the walk by subject started from, each with the memory that brought it in; the memories it
 * could send, those sent first in the order sent, then the rest of the fused list, then the rest of what the walk
 * found (at most `KNOWLEDGE_SHOWN`, the rest counted in `more`), each with its place in the list about a seed and the
 * seeds it is about, its place in the list the message's words reach with its score and those words, its place in
 * the list by meaning with its cosine (each place with the memory it replaced that took it, `via`, when one did, and
 * then that memory's seeds, score, words and cosine), its place in
 * the walk with the entity it was found by, its fused score, whether it was sent and why or why not, and the
 * memories sent under it as what it replaced; the ids sent, in order; and what the note costs, in tokens (0 with no
 * note).
 *
 * @public
 */
export const KnowledgeRecalledData = Schema.Struct({
  last: Schema.String,
  before: Schema.Struct({ user: Schema.String, answer: Schema.String }),
  limit: Schema.Number,
  walk: Schema.Number,
  weights: Schema.Struct({ seed: Schema.Number, words: Schema.Number, meaning: Schema.Number }),
  meaning: Schema.NullOr(Schema.Struct({ model: Schema.String, pool: Schema.Number, floor: Schema.NullOr(Schema.Number), skipped: Schema.NullOr(Schema.String) })),
  seeds: Schema.Array(Schema.Struct({ id: EntityId, name: Schema.String, by: SeedWay, word: Schema.String })),
  bridges: Schema.Array(Schema.Struct({ id: EntityId, name: Schema.String, from: MemoryId })),
  memories: Schema.Array(Schema.Struct({
    id: MemoryId,
    text: Schema.String,
    about: Schema.Array(EntityId),
    seed: Schema.NullOr(Schema.Struct({ place: Schema.Number, seeds: Schema.Array(EntityId), via: Schema.NullOr(MemoryId) })),
    words: Schema.NullOr(Schema.Struct({ place: Schema.Number, score: Schema.Number, terms: Schema.Array(Schema.String), via: Schema.NullOr(MemoryId) })),
    meaning: Schema.NullOr(Schema.Struct({ place: Schema.Number, cosine: Schema.Number, via: Schema.NullOr(MemoryId) })),
    walk: Schema.NullOr(Schema.Struct({ place: Schema.Number, from: EntityId })),
    fused: Schema.Number,
    sent: Schema.Boolean,
    why: RecalledWhy,
    before: Schema.Array(MemoryId),
  })),
  more: Schema.Number,
  sent: Schema.Array(MemoryId),
  tokens: Schema.Number,
})
export type KnowledgeRecalledData = typeof KnowledgeRecalledData.Type

/**
 * `plugin.knowledge.recalled`: what `withKnowledge` or `withKnowledgeByMeaning` did for one request (ADRs 0023 and
 * 0025), said live about the turn and never
 * stored, tagged `trace`. It is said for every model call the memory builds a context for, whether or not anything
 * was named or sent, so a client can show why a request was sent the memories it was, or none.
 *
 * @public
 */
export const knowledgeRecalledEvent = liveEvent("knowledge", "recalled", { tags: ["trace"], data: KnowledgeRecalledData })
