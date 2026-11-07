---
"@xandreed/core": minor
"@xandreed/plugin-memory": minor
"@xandreed/plugin-rag": minor
---

An extraction whose records supersede nothing no longer fails for giving them no supersession. The output schema required `supersession` on every extracted memory and relation, so a reply with `"supersession": null` beside an empty `supersedes`, or without the key, failed to decode: the memory job failed with `Invalid` or the document graph was omitted. `KnowledgeExtractedMemory.supersession` and `KnowledgeExtractedAssertion.supersession` are now optional and nullable, and the output schema says they are required only when `supersedes` is non-empty. `stageKnowledgeExtraction` reads a supersession only from a record that supersedes others, and drops a record that supersedes others without one with a `RecordDropped` note, staging the rest. Extraction version 7 moves the engine ids to `memory:7/…` and `rag:7/…`; `retry` requeues a failed version 6 job under the new id through `KnowledgeIndex.requeue`.
