---
"@xandreed/core": minor
"@xandreed/plugin-memory": minor
"@xandreed/plugin-rag": patch
---

A record that replaces another now links it, and memory recall shows the earlier state it replaced within a labelled share of its budget. `KnowledgeMemory.replaces` and `KnowledgeAssertion.replaces` (`{ id, supersession }`) are written on the successor at staging, never on the retired record: a memory links the memories it supersedes with the extracted memory's new `supersession` (`change` or `correction`, extraction prompt version 3), a relation's change links its history copy and a correction the retired relation; older records decode with none. `KnowledgeRecall.history` (`"changes"` by default, `"all"`, `"none"`) and `historyShare` (default 0.2) select earlier states one hop back from the recalled records, in three deterministic passes (`budgetKnowledgeRecall`), into `KnowledgeRecallResult.history`. `renderMemoryRecall` shows them under "Earlier states, no longer current:" as `previously: … (until YYYY-MM-DD; replaced by …)` or `(corrected YYYY-MM-DD; this was wrong)`; `MemoryConfig.recallHistory` and `recallHistoryShare` set them for the `memory.recalled` section (version 3), `memoryRecallNote` and `recall_memory`, which gains a `history` parameter. `knowledgeStoreConformance` gains `knowledge.supersession-links`. Document retrieval returns no earlier states.
