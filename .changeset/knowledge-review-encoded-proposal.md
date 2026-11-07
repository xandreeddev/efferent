---
"@xandreed/core": minor
"@xandreed/plugin-memory": minor
"@xandreed/plugin-rag": minor
---

The evidence review no longer fails on a proposal the reviewer keeps. `knowledgeReviewPrompt` wrote the decoded extraction with `JSON.stringify`, so an absent `existing` identity or `validFrom`/`validTo` date reached the reviewer as Effect's `Option` object, and a reviewer that copied it back returned JSON the output schema refuses: the memory job failed with `Invalid` or the document graph was omitted. The proposal is now the output schema's wire form, encoded by `KnowledgeExtraction` (an absent value is `null`), so returning it unchanged decodes to the same extraction. Extraction version 6 moves the engine ids to `memory:6/…` and `rag:6/…`; `retry` requeues a failed version 5 job under the new id through `KnowledgeIndex.requeue`.
