import { Effect, Layer, Option, Result } from "effect"
import { Sessions } from "@xandreed/core/kernel"
import { knowledgeOf } from "../../contracts/knowledge/knowledge.entity.functions.js"
import { askedOf, checkedKnowledgeOptions, knowledgeNote, knowledgeRecalledOf, recallKnowledge } from "../../contracts/knowledge/knowledge-recall.entity.functions.js"
import { knowledgeRecalledEvent } from "../../contracts/knowledge/knowledge-recall.entity.js"
import type { KnowledgeOptions } from "../../contracts/knowledge/knowledge-recall.entity.js"
import { knowledgeJournal } from "../../contracts/knowledge/knowledge.usecase.js"
import { Memory } from "../../contracts/memory/memory.port.js"

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
