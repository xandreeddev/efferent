---
"@xandreed/core": minor
"@xandreed/plugin-knowledge-postgres": minor
"@xandreed/plugin-rag": patch
"@xandreed/plugin-memory": patch
---

A failed knowledge job records why it failed: `KnowledgeIndex.fail(lease, failure)` takes a `KnowledgeJobFailure` (`reason`, `message` and the `step` that failed, `Graph` or `Required`) instead of a message, and the job's `Failed` phase keeps it, so hosts read the reason from `status` instead of matching message text. `isRetryableKnowledgeFailure` is the rule the RAG and memory engines retry by, exported for hosts deciding whether to `retry`. A job stored with only a message decodes as `Unavailable` at step `Required`; the PostgreSQL store keeps the failure in the job payload with its layout unchanged. `knowledgeStoreConformance` adds `knowledge.failure-reason`; a host's own `KnowledgeIndex` adopts the new `fail`.
