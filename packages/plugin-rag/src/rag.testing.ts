import { EmbeddingModel } from "effect/ai"
import { Context, Effect, Layer, Option, Ref } from "effect"
import {
  Knowledge, KnowledgeJobId, KnowledgeSourceId, KnowledgeStore, makeKnowledgeIndexMemory, UtilityCompletion, UtilityError, UtilityLlm, zeroUsage,
} from "@xandreed/core"
import type { KnowledgeEnqueue, KnowledgeIndex, KnowledgeScope, KnowledgeSource } from "@xandreed/core"
import { RagLive } from "./rag-engine.adapter.js"
import { ragDefaults } from "./rag.entity.js"
import type { RagConfig } from "./rag.entity.js"

export const scope: KnowledgeScope = { owner: "fixture", namespace: "default", collection: "knowledge" }
export const enqueue = (name: string, text: string, revision = 1, metadata: KnowledgeSource["metadata"] = {}): KnowledgeEnqueue => ({
  jobId: KnowledgeJobId.make(`${name}:${revision}`), engine: "host", expectedRevision: revision === 1 ? Option.none() : Option.some(revision - 1),
  source: { scope, ref: { id: KnowledgeSourceId.make(name), revision }, text, occurredAt: 10, recordedAt: 20, metadata },
})
export const makeEmbeddings = (map: (text: string) => Array<number> = () => [1, 0]) => EmbeddingModel.make({
  embedMany: ({ inputs }) => Effect.succeed({ results: inputs.map(map), usage: { inputTokens: inputs.length } }),
})
/** Replies by call order: a reply's text alone, or a whole completion (a finish reason, usage). */
export const scriptedUtility = (replies: ReadonlyArray<string | UtilityCompletion>) => Effect.gen(function* () {
  const prompts = yield* Ref.make<ReadonlyArray<string>>([])
  const utility = UtilityLlm.of({ complete: (prompt) => Ref.getAndUpdate(prompts, (all) => [...all, prompt]).pipe(Effect.flatMap((previous) => {
    const reply = replies[previous.length]
    return reply === undefined ? Effect.fail(new UtilityError({ message: "No scripted response remains" }))
      : Effect.succeed(typeof reply === "string" ? new UtilityCompletion({ text: reply, usage: zeroUsage }) : reply)
  })) })
  return { utility, prompts }
})
export const makeRag = (options: Partial<RagConfig> = {}, ownStore?: KnowledgeIndex, ownEmbeddings?: EmbeddingModel.EmbeddingModel, utility?: typeof UtilityLlm.Service) => Effect.gen(function* () {
  const store = ownStore ?? (yield* makeKnowledgeIndexMemory())
  const embeddings = ownEmbeddings ?? (yield* makeEmbeddings())
  const context = Context.make(KnowledgeStore, store).pipe(Context.add(EmbeddingModel.EmbeddingModel, embeddings))
  const services = utility === undefined ? context : Context.add(context, UtilityLlm, utility)
  const built = yield* Layer.build(RagLive({ ...ragDefaults, worker: false, embeddingDimensions: 2, maxAttempts: 1, ...options }).pipe(Layer.provide(Layer.succeedContext(services))))
  return { store, embeddings, services, knowledge: Context.get(built, Knowledge), built }
})
