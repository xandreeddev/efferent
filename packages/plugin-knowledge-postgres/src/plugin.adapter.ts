import { Config, Context, Effect, Layer, Redacted } from "effect"
import { definePlugin, KnowledgeStore, MemoryStore, TemporalGraph } from "@xandreed/core"
import { KnowledgePostgresConfig, knowledgePostgresDefaults } from "./knowledge-postgres.entity.js"
import { makePostgresDatabase, migratePostgres } from "./postgres-connection.adapter.js"
import { makePostgresIndex } from "./knowledge-store.adapter.js"

/** Open one scoped database for native memory, RAG and the memory temporal graph. @public */
export const makeKnowledgePostgres = Effect.fn("knowledge_postgres.make")(function* (
  url: Redacted.Redacted<string>,
  options: Partial<KnowledgePostgresConfig> = {},
) {
  const database = yield* makePostgresDatabase(url, { ...knowledgePostgresDefaults, ...options })
  yield* migratePostgres(database)
  const memory = makePostgresIndex(database, "memory")
  const knowledge = makePostgresIndex(database, "knowledge")
  return { memory, knowledge, graph: { traverse: memory.traverse } }
})

/** PostgreSQL persistence with an explicit secret URL for hosts that manage credentials. @public */
export const KnowledgePostgresLive = (url: Redacted.Redacted<string>, options: Partial<KnowledgePostgresConfig> = {}) =>
  Layer.effectContext(makeKnowledgePostgres(url, options).pipe(Effect.map((store) => Context.make(MemoryStore, store.memory).pipe(
    Context.add(KnowledgeStore, store.knowledge),
    Context.add(TemporalGraph, store.graph),
  ))))

/** Native stores backed by PostgreSQL and pgvector; credentials are read through Config. @public */
export const knowledgePostgresPlugin = definePlugin({
  id: "@xandreed/plugin-knowledge-postgres", version: "0.21.1", scope: "runtime",
  config: KnowledgePostgresConfig, defaults: knowledgePostgresDefaults,
  provides: [MemoryStore, KnowledgeStore, TemporalGraph],
  layer: (config) => Layer.effectContext(Effect.gen(function* () {
    const url = yield* Config.Redacted(config.urlEnv)
    const store = yield* makeKnowledgePostgres(url, config)
    return Context.make(MemoryStore, store.memory).pipe(
      Context.add(KnowledgeStore, store.knowledge),
      Context.add(TemporalGraph, store.graph),
    )
  })),
})

/** The runtime plugin's typed environment-based layer. @public */
export const KnowledgePostgresPluginLive = knowledgePostgresPlugin.live
