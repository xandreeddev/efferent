---
"@xandreed/plugin-rag": patch
"@xandreed/core": minor
---

Optional graph extraction no longer keeps a document out of plain retrieval: a failed or invalid extraction or review is recorded on the job and retried within `maxAttempts`, and the last attempt publishes the source's chunks without the graph, its stage carrying a `GraphOmitted` note (`KnowledgeStage.notes`, `KnowledgeStageNote`). `knowledgeConformance` gains `failed-extraction`, with an optional `failingExtraction` subject, and `knowledgeStoreConformance`'s `stage-retry` requires a stage's notes to survive retry.
