---
"@xandreed/core": minor
"@xandreed/plugin-rag": minor
"@xandreed/plugin-memory": minor
"@xandreed/plugin-knowledge-postgres": minor
---

Knowledge retrieval and recall results carry `sources`, the times and metadata of every source revision they cite, read in one call to the new `KnowledgeIndex.sourceInfo`; the RAG and memory plugins export the evidence and source-page formatters their tools use. A host's own `KnowledgeIndex` adds `sourceInfo`.
