---
"@xandreed/core": minor
"@xandreed/plugin-knowledge-postgres": patch
"@xandreed/plugin-rag": patch
"@xandreed/plugin-memory": patch
---

Knowledge workers process only the jobs of their own embedding space: `plugin-rag` and `plugin-memory` record, discover and claim jobs under `knowledgeEngineId(processor, space)`, derived from their embedding options, instead of the constant `rag:1` / `memory:1`. `KnowledgeClaim` gains a required `engine`, and the in-memory and PostgreSQL stores claim only jobs recorded under it, by job id too. `knowledgeStoreConformance` adds `knowledge.engine-isolation`, and its `knowledge.pending-discovery` check no longer depends on other checks' jobs in a shared namespace and collection. Jobs queued under the old ids and never completed must be ingested or captured again as the next source revision.
