---
"@xandreed/core": minor
"@xandreed/plugin-knowledge-postgres": minor
"@xandreed/plugin-rag": minor
"@xandreed/plugin-memory": minor
---

Hosts find failed knowledge jobs and start them over for the current engine: `KnowledgeIndex.failed(query)` lists failed jobs across owners in a namespace (optionally by engine, collection and failure reasons), oldest first, with a cursor, and `KnowledgeIndex.requeue({ scope, jobId, engine })` requeues a failed job under `engine` with its attempts reset, keeping its stage only under the same engine. A job whose source was forgotten is refused with `Tombstoned` (checked before its phase, since forgetting cancels the source's jobs), a superseded or unfailed one with `Conflict`. `Knowledge.retry` and `LongTermMemory.retry` requeue under the engine's current id, so attempts reset and a job failed under an older extraction version or embedding space is taken over; they refuse a scope outside the engine's collection. The store's `retry` still keeps engine and attempts for the engines' own bounded retries. The PostgreSQL store creates the partial index `jobs_failed` on open when it is missing and leaves its layout at 1, so an earlier release still opens the database; building the index blocks writes to the jobs table once (on a large table, create it beforehand with `CREATE INDEX CONCURRENTLY`). `knowledgeStoreConformance` adds `knowledge.failed-listing` and `knowledge.requeue`; a host's own `KnowledgeIndex` implements both methods.
