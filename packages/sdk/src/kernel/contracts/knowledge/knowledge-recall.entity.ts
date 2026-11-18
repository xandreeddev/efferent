import { Schema } from "effect"
import type { Option } from "effect"
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
 * words there (`speaker`: the user's entity), or by its name in the turn before, when the last message named nothing
 * (`before`).
 *
 * @public
 */
export const SeedWay = Schema.Literals(["name", "speaker", "before"])
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
 * A memory of the fused list: how it was scored, its place (from 1) in the list of memories about a seed and in the
 * list the message's words reach, when it is in them, and its fused score.
 *
 * @public
 */
export interface FusedMemory extends ScoredMemory {
  readonly seed: Option.Option<number>
  readonly words: Option.Option<number>
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
 * What recall did for one request (`recallKnowledge`): what was asked, the seeds, the fused list, best first, all
 * of it; the entities the walk started from; every memory it could have taken, best first, all of them; and what is
 * sent, in order.
 *
 * @public
 */
export interface KnowledgeRecall {
  readonly asked: Asked
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
 * The data of `plugin.knowledge.recalled`: what `withKnowledge` did for one request (ADR 0023). What was asked (each
 * text at most `ASKED_SHOWN` characters, what was cut counted); the options it ran with; the seeds, each with how it
 * was named; the entities the walk by subject started from, each with the memory that brought it in; the memories it
 * could send, those sent first in the order sent, then the rest of the fused list, then the rest of what the walk
 * found (at most `KNOWLEDGE_SHOWN`, the rest counted in `more`), each with its place in the list about a seed and the
 * seeds it is about, its place in the list the message's words reach with its score and those words, its place in
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
  seeds: Schema.Array(Schema.Struct({ id: EntityId, name: Schema.String, by: SeedWay, word: Schema.String })),
  bridges: Schema.Array(Schema.Struct({ id: EntityId, name: Schema.String, from: MemoryId })),
  memories: Schema.Array(Schema.Struct({
    id: MemoryId,
    text: Schema.String,
    about: Schema.Array(EntityId),
    seed: Schema.NullOr(Schema.Struct({ place: Schema.Number, seeds: Schema.Array(EntityId) })),
    words: Schema.NullOr(Schema.Struct({ place: Schema.Number, score: Schema.Number, terms: Schema.Array(Schema.String) })),
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
 * `plugin.knowledge.recalled`: what `withKnowledge` did for one request (ADR 0023), said live about the turn and never
 * stored, tagged `trace`. It is said for every model call the memory builds a context for, whether or not anything
 * was named or sent, so a client can show why a request was sent the memories it was, or none.
 *
 * @public
 */
export const knowledgeRecalledEvent = liveEvent("knowledge", "recalled", { tags: ["trace"], data: KnowledgeRecalledData })
