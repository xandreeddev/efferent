import { EmbeddingModel } from "effect/ai"
import { Context, Effect, Layer, Option, Ref } from "effect"
import { CurrentKnowledgeHelperCall, KnowledgeJobId, KnowledgeSourceId, LongTermMemory, MemoryStore, UtilityCompletion, UtilityLlm, makeKnowledgeIndexMemory, zeroUsage } from "@xandreed/core"
import type { KnowledgeEnqueue, KnowledgeHelperCall, KnowledgeScope } from "@xandreed/core"
import { MemoryLive } from "./memory-engine.adapter.js"
import { memoryDefaults } from "./memory.entity.js"
import type { MemoryConfig } from "./memory.entity.js"

export const fixtureScope: KnowledgeScope = { owner: "fixture-owner", namespace: "fixture", collection: "memory" }
export const fixtureEnqueue = (id: string, text: string, scope = fixtureScope): KnowledgeEnqueue => ({
  jobId: KnowledgeJobId.make(`job:${id}`), engine: "memory:1", expectedRevision: Option.none(),
  source: { scope, ref: { id: KnowledgeSourceId.make(id), revision: 1 }, text, occurredAt: 1, recordedAt: 2, metadata: { kind: "conversation", session: id } },
})
export const fixtureExtraction = (text: string) => ({
  entities: [{ key: "person", name: "User", type: "person", aliases: [], existing: null, spans: [{ start: 0, end: text.length, quote: text }] }],
  memories: [{ key: "preference", kind: "preference", text, entities: ["person"], spans: [{ start: 0, end: text.length, quote: text }], evidence: { _tag: "Stated" }, supersedes: [], supersession: "change" }],
  assertions: [{ key: "prefers", subject: "person", predicate: "prefers", object: { _tag: "Value", value: "tea" }, text, spans: [{ start: 0, end: text.length, quote: text }], validFrom: null, validTo: null, supersedes: [], supersession: "correction" }],
})
/** Replies by call order, or computed from each call's prompt and helper context. */
export const makeMemoryFixture = (responses: ReadonlyArray<string> | ((prompt: string, call: Option.Option<KnowledgeHelperCall>) => string), options: Partial<MemoryConfig> = {}) => Effect.gen(function* () {
  const calls = yield* Ref.make<ReadonlyArray<string>>([])
  const helperCalls = yield* Ref.make<ReadonlyArray<Option.Option<KnowledgeHelperCall>>>([])
  const store = yield* makeKnowledgeIndexMemory()
  const embeddings = yield* EmbeddingModel.make({ embedMany: ({ inputs }) => Effect.succeed({ results: inputs.map((text) => text.toLowerCase().includes("coffee") ? [0, 1] : [1, 0]), usage: { inputTokens: undefined } }) })
  const utility = UtilityLlm.of({ complete: (prompt) => Effect.service(CurrentKnowledgeHelperCall).pipe(
    Effect.tap((call) => Ref.update(helperCalls, (all) => [...all, call])),
    Effect.flatMap((call) => Ref.modify(calls, (seen): [number, ReadonlyArray<string>] => [seen.length, [...seen, prompt]]).pipe(
      Effect.map((index) => new UtilityCompletion({ text: typeof responses === "function" ? responses(prompt, call) : responses[index] ?? responses.at(-1) ?? "{}", usage: zeroUsage })),
    )),
  ) })
  const services = Context.make(MemoryStore, store).pipe(Context.add(UtilityLlm, utility), Context.add(EmbeddingModel.EmbeddingModel, embeddings))
  const config = { ...memoryDefaults, namespace: fixtureScope.namespace, embeddingDimensions: 2, worker: false, review: false, ...options }
  const live = yield* Layer.build(MemoryLive(config).pipe(Layer.provide(Layer.succeedContext(services))))
  return { store, calls, helperCalls, services, config, memory: Context.get(live, LongTermMemory) }
})
