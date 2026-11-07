---
"@xandreed/core": minor
"@xandreed/plugin-memory": minor
"@xandreed/plugin-rag": minor
"@xandreed/plugin-knowledge-postgres": minor
---

Memory recall shows near-duplicate memories as one, and semantic search takes an optional similarity floor. After the support and event weights, a memory of the same kind and event time as a kept memory ranked above it, whose embedding cosine with it is at least `MemoryConfig.recallCollapseSimilarity` (default 0.95; `false` turns it off), is folded into it: it frees its place and budget, and the kept candidate names it in `KnowledgeCandidate.alike` and carries its spans and mentions, so its support counts both and both sources are cited. Passages never fold and nothing changes in the store; the `memory.recalled` section is version 7, and shows a profile record recall folded once, with the profile's count. `KnowledgeSearch.minSimilarity` leaves semantic candidates below a cosine floor out before the limit, and keeps every one at or above it (0 and below included), in the in-memory and PostgreSQL stores; `MemoryConfig.recallMinSimilarity` and `RagConfig.minSimilarity` pass one and are absent by default. `knowledgeStoreConformance` gains `knowledge.similarity-floor`.
