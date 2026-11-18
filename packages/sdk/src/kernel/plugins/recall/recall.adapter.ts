import { Array as Arr, Effect, Layer, Option, Result } from "effect"
import { Sessions } from "@xandreed/core/kernel"
import { Embedder } from "../../contracts/embedder/embedder.port.js"
import { memoryJournal } from "../../contracts/facts/facts.usecase.js"
import { graphJournal } from "../../contracts/graph/graph.usecase.js"
import { questionOf } from "../../contracts/memory/memory.entity.functions.js"
import { Memory } from "../../contracts/memory/memory.port.js"
import { checkedModel, checkedRecallOptions, foundItems, recallItems, recalledByMeaningOf, recallKey, recallNote, recallText, reordered } from "../../contracts/recall/recall.entity.functions.js"
import { recalledByMeaningEvent } from "../../contracts/recall/recall.entity.js"
import type { RecallItem, RecallOptions } from "../../contracts/recall/recall.entity.js"
import { VectorStore } from "../../contracts/vector-store/vector-store.port.js"
import { ReorderInvalid } from "./recall.entity.js"

/**
 * The most texts embedded in one call: a request that stops lands between two calls, and a service over the network
 * caps how many inputs one call may hold.
 */
const EMBED_CHUNK = 32

/**
 * A wrapper of `Memory` (ADR 0005, ADR 0021, amended): for each request it reads the links and the facts that stand
 * (the graph session's journal and the memory session's, each read once, neither created), embeds as passages, 32 at
 * a time, the texts the store lacks under the embedder's model (`recallKey`), embeds the question as a query, and
 * searches among the keys of what stands for `pool` of them. A key found stands for every standing item with its
 * text, links first, each counted against the limit. When the host gives `reorder`, the items found are put in its
 * order (items of one score in the order found). It adds `recallNote` of the first `limit` of them, last, after the
 * context the memory below returned. The question is the user's last message in the conversation's journal; with no
 * question, or nothing standing, nothing is embedded and nothing added. Nothing is stored in a journal.
 *
 * What it found is said live for every request, `plugin.recall.recalled` (`recalledByMeaningOf`); a listener that
 * fails is logged and costs the request nothing. An embedder that fails (`EmbedFailed`), a store that refuses
 * (`VectorsRefused`), a reorder that fails, and one whose scores make no order (`ReorderInvalid`) fail the context as
 * they are, in words: a request is never sent as though nothing were known. A store whose medium fails
 * (`VectorsUnavailable`) is a defect, as its port says. Options that are none are refused here, where they are
 * written, and an embedder's model name too long to key vectors where the layer is built.
 *
 * @public
 */
export const withRecall = (options: RecallOptions) => {
  const checked = Result.getOrThrowWith(checkedRecallOptions(options), (problem) => new Error(problem))
  return <E, R>(memory: Layer.Layer<Memory, E, R>): Layer.Layer<Memory, E, R | Sessions | Embedder | VectorStore> =>
    Layer.effect(Memory, Effect.gen(function* () {
      const below = yield* Memory
      const sessions = yield* Sessions
      const embedder = yield* Embedder
      const store = yield* VectorStore
      const model = yield* Result.match(checkedModel(embedder.model), { onFailure: (problem) => Effect.die(new Error(problem)), onSuccess: Effect.succeed })
      return Memory.of({
        context: Effect.fnUntraced(function* (session) {
          const context = yield* below.context(session)
          const graph = yield* Effect.provideService(graphJournal, Sessions, sessions)
          const facts = yield* Effect.provideService(memoryJournal, Sessions, sessions)
          const items = recallItems(graph, facts)
          const question = questionOf(yield* session.journal)
          const say = (
            found: ReadonlyArray<{ readonly item: RecallItem; readonly score: number }>,
            order: Option.Option<ReadonlyArray<{ readonly item: RecallItem; readonly score: number }>>,
            sent: ReadonlyArray<RecallItem>,
          ) =>
            session.publish(recalledByMeaningEvent, recalledByMeaningOf(question, model, checked, found, order, sent))
              .pipe(Effect.ignoreCause({ log: "Warn", message: "what recall by meaning found could not be said" }))
          if (items.length === 0 || question.trim().length === 0) {
            yield* say([], Option.none(), [])
            return context
          }
          // Every key is made from a model checked where the layer was built and a text the journal held to its limit.
          const keyed = yield* Effect.orDie(Effect.fromResult(Result.all(items.map((item) => Result.map(recallKey(model, item), (key) => ({ item, key }))))))
          const keys = Arr.dedupe(keyed.map(({ key }) => key))
          const textOf = new Map(keyed.map(({ item, key }) => [key, recallText(item)]))
          const stored = new Set(yield* store.has(keys).pipe(Effect.catchTag("VectorsUnavailable", (unavailable) => Effect.die(unavailable))))
          const missing = keys.filter((key) => !stored.has(key))
          yield* Effect.forEach(Arr.chunksOf(missing, EMBED_CHUNK), (chunk) => Effect.gen(function* () {
            const vectors = yield* embedder.embed(chunk.map((key) => textOf.get(key) ?? ""), "passage")
            const entries = chunk.flatMap((key, at) => Option.toArray(Option.map(Option.fromNullishOr(vectors[at]), (vector) => ({ key, vector }))))
            if (entries.length !== chunk.length) return yield* Effect.die(new Error(`the embedder gave ${vectors.length} vectors for ${chunk.length} texts`))
            yield* store.put(entries).pipe(Effect.catchTag("VectorsUnavailable", (unavailable) => Effect.die(unavailable)))
          }), { concurrency: 1, discard: true })
          const asked = (yield* embedder.embed([question], "query"))[0]
          if (asked === undefined) return yield* Effect.die(new Error("the embedder gave no vector for the question"))
          const scored = yield* store.search(asked, { limit: checked.pool, among: keys }).pipe(Effect.catchTag("VectorsUnavailable", (unavailable) => Effect.die(unavailable)))
          const found = foundItems(keyed, scored)
          const order = yield* Option.match(checked.reorder, {
            onNone: () => Effect.succeed(Option.none<ReadonlyArray<{ readonly item: RecallItem; readonly score: number }>>()),
            onSome: (reorder) => found.length === 0
              ? Effect.succeed(Option.none<ReadonlyArray<{ readonly item: RecallItem; readonly score: number }>>())
              : Effect.flatMap(reorder(question, found), (scores) => Result.match(reordered(found, scores), {
                onFailure: (message) => Effect.fail(new ReorderInvalid({ message })),
                onSuccess: (list) => Effect.succeed(Option.some(list)),
              })),
          })
          const chosen = Option.getOrElse(order, () => found).slice(0, checked.limit).map(({ item }) => item)
          yield* say(found, order, chosen)
          return chosen.length === 0 ? context : [...context, { role: "user" as const, content: recallNote(chosen) }]
        }),
      })
    })).pipe(Layer.provide(memory))
}
