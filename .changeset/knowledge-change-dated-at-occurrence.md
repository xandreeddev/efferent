---
"@xandreed/core": minor
"@xandreed/plugin-memory": patch
"@xandreed/plugin-rag": patch
---

Native knowledge extraction (version 2, so the engines' ids become `memory:2/…` and `rag:2/…`) dates a world change stated without a date at its source's occurrence time, recorded as `KnowledgeAssertion.validFromBasis: "observed"`, instead of failing the job, and leaves out only the extracted records that fail their own checks, each with a `RecordDropped` stage note, while the rest of the turn or document graph publishes. The extraction prompt shows the occurrence time as ISO 8601 with its epoch milliseconds. A job still fails with `Invalid` when the extraction repeats an entity key or keeps none of the memories and relations it proposed (its entities alone do not count). The knowledge kits gain `knowledge.stage-notes` and `dropped-record`.
