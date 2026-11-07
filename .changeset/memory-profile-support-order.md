---
"@xandreed/core": patch
"@xandreed/plugin-memory": patch
---

Order the memory profile by support and recency instead of the store's order. `LongTermMemory.profile` returns `KnowledgeProfileMemory` (a `KnowledgeMemory` with an optional `support`), each current preference or profile memory counted from the revisions it mentions in one `sourceInfo` read, sorted by the new `knowledgeProfileOrder`: more episodes first, then said more recently, then by id. The `memory.recalled` section (version 6) and `memoryRecallNote` keep that order, label each profile record with its count, and cut at four only after the run's narrowing; a record shown without a restatement outside the reach shows no count. `supportWeight: 0` reads nothing and orders the profile by id. `longTermMemoryConformance` gains `profile-order`.
