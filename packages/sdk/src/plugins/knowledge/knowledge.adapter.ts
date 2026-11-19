import { Array as Arr, Effect, Layer, Option, Predicate, Ref, Result } from "effect"
import { Sessions } from "@xandreed/core"
import type { EmbedFailed, Vector } from "../../contracts/embedder/embedder.entity.js"
import { Embedder } from "../../contracts/embedder/embedder.port.js"
import { knowledgeOf } from "../../contracts/knowledge/knowledge.entity.functions.js"
import {
  askedOf, checkedKnowledgeOptions, checkedMeaningOptions, checkedModel, knowledgeNote, knowledgeRecalledOf, meaningKey, meaningTexts, recallKnowledge,
} from "../../contracts/knowledge/knowledge-recall.entity.functions.js"
import { knowledgeRecalledEvent } from "../../contracts/knowledge/knowledge-recall.entity.js"
import type { FoundText, KnowledgeOptions, MeaningOptions } from "../../contracts/knowledge/knowledge-recall.entity.js"
import { knowledgeJournal } from "../../contracts/knowledge/knowledge.usecase.js"
import { Memory } from "../../contracts/memory/memory.port.js"
import { VectorStore } from "../../contracts/vector-store/vector-store.port.js"

/**
 * A wrapper of `Memory` (ADR 0005, ADR 0023): for each request it reads the knowledge session (none is created),
 * chooses what is stored about what the conversation names (`recallKnowledge`: seeds from the last message, else the
 * turn before; memories about them and those the message's words reach, fused by rank; then a walk by subject), and
 * adds `knowledgeNote` of them, last, after the context the memory below returned. No model is called and nothing is
 * embedded. The conversation is read from its journal (`askedOf`), never from the context. Nothing is stored, and
 * with nothing to send nothing is added.
 *
 * What it did is said live for every request, `plugin.knowledge.recalled` (`knowledgeRecalledOf`); a listener that
 * fails is logged and costs the request nothing. Options that are none are refused here, where they are written: it
 * throws, as a definition does.
 *
 * @public
 */
export const withKnowledge = (options: KnowledgeOptions = {}) => {
  const checked = Result.getOrThrowWith(checkedKnowledgeOptions(options), (problem) => new Error(problem))
  return <E, R>(memory: Layer.Layer<Memory, E, R>): Layer.Layer<Memory, E, R | Sessions> =>
    Layer.effect(Memory, Effect.gen(function* () {
      const below = yield* Memory
      const sessions = yield* Sessions
      return Memory.of({
        context: Effect.fnUntraced(function* (session) {
          const context = yield* below.context(session)
          const knowledge = knowledgeOf(yield* Effect.provideService(knowledgeJournal, Sessions, sessions))
          const recall = recallKnowledge(knowledge, askedOf(yield* session.journal), checked)
          const note = recall.sent.length === 0 ? Option.none<string>() : Option.some(knowledgeNote(recall.sent))
          yield* session.publish(knowledgeRecalledEvent, knowledgeRecalledOf(recall, checked, note))
            .pipe(Effect.ignoreCause({ log: "Warn", message: "what recall from the knowledge did could not be said" }))
          return Option.match(note, { onNone: () => context, onSome: (content) => [...context, { role: "user" as const, content }] })
        }),
      })
    })).pipe(Layer.provide(memory))
}

/**
 * The most texts embedded in one call: a request that stops lands between two calls, and a service over the network
 * caps how many inputs one call may hold.
 */
const EMBED_CHUNK = 32

/** The most distinct reasons one layer warns of an embedder's failure for: past them it goes on, and says no more. */
const WARNED_REASONS = 32

/**
 * What an embedder's failure is, for its warning to be said once: its cause's tag and that cause's reason's
 * (`AiError/AuthenticationError`, `ModelSpendExceeded`), so the same refusal of every request is one reason whatever
 * its words; else its words.
 */
const reasonOf = (failed: EmbedFailed): string => {
  const cause: unknown = failed.cause
  const tags = [cause, Predicate.hasProperty(cause, "reason") ? cause.reason : undefined]
    .flatMap((value) => (Predicate.hasProperty(value, "_tag") && Predicate.isString(value._tag) ? [value._tag] : []))
  return tags.length > 0 ? tags.join("/") : failed.message
}

/**
 * A wrapper of `Memory` (ADRs 0005, 0023 and 0025): `withKnowledge`, with a third list, ranked by meaning, fused by
 * rank with the list about a seed and the list the message's words reach. It needs an `Embedder` and a `VectorStore`
 * beside `Sessions`.
 *
 * For each request, when the list by meaning has a weight above 0, the last message is not empty and something can be
 * ranked: the texts of the memories recall can rank (`meaningTexts`: those that stand, and those ended as `changed`
 * into one that stands) are keyed by the embedder's model and the text (`meaningKey`, never an id); those the store
 * lacks are embedded as passages, 32 a call, and put; the last message alone is embedded as a query, and the store is
 * searched among those keys for `pool` of them. Vectors are an index of the journal (ADR 0021): lost, they are made
 * again from it the same way, and a host may put vectors made ahead under the same keys. What was found goes to
 * `recallKnowledge`, which fuses the three lists by `weights`; a weight of 0 turns a list off, and with the list by
 * meaning off nothing is embedded or searched. The walk by subject, the note (`knowledgeNote`) and what is added are
 * `withKnowledge`'s.
 *
 * What it did is said live for every request, `plugin.knowledge.recalled`, with each memory's place and cosine in the
 * list by meaning and the embedder's model; a listener that fails is logged and costs the request nothing. An
 * embedder that fails (`EmbedFailed`, for a passage or the message: a model not loaded yet, a service down or refused
 * by a spend cap) does not fail the context: the list by meaning is skipped for that request, recall runs by the other
 * lists as weighted, and the event says why (`meaning.skipped`). So that an embedder that never works (a wrong key, a
 * model with no price) is seen, the layer logs a warning the first time each reason fails it (by the failure's cause
 * and that cause's reason, else its words; at most 32 reasons a layer), and nothing more for it after.
 *
 * The last message's vector is kept by the layer for the turn it was asked in, while the message is the same: the steps
 * of one turn, each asking for a context, embed it once; the next turn embeds its own, the same words included. Passages are embedded 32 a call and each call's vectors put as it returns, so a call that
 * fails leaves those before it stored, and the next request embeds only what is still missing. A store that refuses (`VectorsRefused`) fails the
 * context as it is; a store whose medium fails (`VectorsUnavailable`) is a defect, as its port says. A `floor` leaves
 * out of the list by meaning every text whose cosine is under it. Options that are none are refused here, where they are written, and an embedder's model name that
 * cannot key a vector (more than `MEANING_MODEL_LIMIT` characters) where the layer is built.
 *
 * @public
 */
export const withKnowledgeByMeaning = (options: MeaningOptions = {}) => {
  const checked = Result.getOrThrowWith(checkedMeaningOptions(options), (problem) => new Error(problem))
  return <E, R>(memory: Layer.Layer<Memory, E, R>): Layer.Layer<Memory, E, R | Sessions | Embedder | VectorStore> =>
    Layer.effect(Memory, Effect.gen(function* () {
      const below = yield* Memory
      const sessions = yield* Sessions
      const embedder = yield* Embedder
      const store = yield* VectorStore
      const model = yield* Result.match(checkedModel(embedder.model), { onFailure: (problem) => Effect.die(new Error(problem)), onSuccess: Effect.succeed })
      const unavailable = { VectorsUnavailable: Effect.die } as const
      // The last message embedded in a turn, and its vector: the steps of a turn ask with the same message.
      const lastAsked = yield* Ref.make(Option.none<{ readonly turn: string; readonly text: string; readonly vector: Vector }>())
      const warned = yield* Ref.make<ReadonlySet<string>>(new Set())
      /** Warn of an embedder's failure the first time its reason is met, at most `WARNED_REASONS` reasons. */
      const warnOnce = (failed: EmbedFailed) => Effect.flatMap(Ref.modify(warned, (seen): readonly [boolean, ReadonlySet<string>] => {
        const reason = reasonOf(failed)
        return seen.has(reason) || seen.size >= WARNED_REASONS ? [false, seen] : [true, new Set([...seen, reason])]
      }), (first) => (first
        ? Effect.logWarning(`recall by meaning is skipped: the embedder ${model} failed, so memories are found by their words alone until it works (${reasonOf(failed)})`)
        : Effect.void))
      /** The last message's vector: kept for the steps of one turn while the message is the same, else embedded as a query. */
      const queryVector = (turn: string, last: string) => Effect.flatMap(Ref.get(lastAsked), (kept) => Option.match(Option.filter(kept, (one) => one.turn === turn && one.text === last), {
        onSome: (one) => Effect.succeed(one.vector),
        onNone: () => Effect.flatMap(embedder.embed([last], "query"), (vectors) => {
          const vector = vectors[0]
          return vector === undefined
            ? Effect.die(new Error("the embedder gave no vector for the last message"))
            : Effect.as(Ref.set(lastAsked, Option.some({ turn, text: last, vector })), vector)
        }),
      }))
      /** The texts nearest the last message among those given, `pool` of them: what is missing embedded and put first. */
      const nearest = Effect.fnUntraced(function* (texts: ReadonlyArray<string>, last: string, turn: string) {
        // Every key is made from a model checked where the layer was built and a text the journal held to its limit.
        const keyed = yield* Effect.orDie(Effect.fromResult(Result.all(texts.map((text) => Result.map(meaningKey(model, text), (key) => ({ text, key }))))))
        const keys = keyed.map(({ key }) => key)
        const textOf = new Map(keyed.map(({ text, key }) => [key, text]))
        const stored = new Set(yield* store.has(keys).pipe(Effect.catchTags(unavailable)))
        const missing = keyed.filter(({ key }) => !stored.has(key))
        yield* Effect.forEach(Arr.chunksOf(missing, EMBED_CHUNK), (chunk) => Effect.gen(function* () {
          const vectors = yield* embedder.embed(chunk.map(({ text }) => text), "passage")
          if (vectors.length !== chunk.length) return yield* Effect.die(new Error(`the embedder gave ${vectors.length} vectors for ${chunk.length} texts`))
          yield* store.put(chunk.map(({ key }, at) => ({ key, vector: vectors[at] ?? [] }))).pipe(Effect.catchTags(unavailable))
        }), { concurrency: 1, discard: true })
        const asked = yield* queryVector(turn, last)
        const found = yield* store.search(asked, { limit: checked.pool, among: keys }).pipe(Effect.catchTags(unavailable))
        return found.flatMap(({ key, score }): ReadonlyArray<FoundText> => Option.toArray(Option.map(Option.fromNullishOr(textOf.get(key)), (text) => ({ text, cosine: score }))))
      })
      return Memory.of({
        context: Effect.fnUntraced(function* (session) {
          const context = yield* below.context(session)
          const knowledge = knowledgeOf(yield* Effect.provideService(knowledgeJournal, Sessions, sessions))
          const asked = askedOf(yield* session.journal)
          const texts = meaningTexts(knowledge)
          // An embedder that fails (a model not loaded, a service down or over its budget) costs the request the list by
          // meaning, and nothing else: recall runs by its other lists, and the event says why.
          const ranked = checked.weights.meaning > 0 && asked.last.trim().length > 0 && texts.length > 0
            ? yield* nearest(texts, asked.last, `${session.id} ${session.turn}`).pipe(
              Effect.map((found) => ({ found, skipped: Option.none<string>() })),
              Effect.catchTag("EmbedFailed", (failed) => Effect.as(warnOnce(failed), { found: [], skipped: Option.some(failed.message) })),
            )
            : { found: [], skipped: Option.none<string>() }
          const recall = recallKnowledge(knowledge, asked, checked, Option.some({ model, pool: checked.pool, weights: checked.weights, floor: checked.floor, ...ranked }))
          const note = recall.sent.length === 0 ? Option.none<string>() : Option.some(knowledgeNote(recall.sent))
          yield* session.publish(knowledgeRecalledEvent, knowledgeRecalledOf(recall, checked, note))
            .pipe(Effect.ignoreCause({ log: "Warn", message: "what recall from the knowledge did could not be said" }))
          return Option.match(note, { onNone: () => context, onSome: (content) => [...context, { role: "user" as const, content }] })
        }),
      })
    })).pipe(Layer.provide(memory))
}
