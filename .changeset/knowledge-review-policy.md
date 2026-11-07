---
"@xandreed/core": minor
"@xandreed/plugin-memory": minor
"@xandreed/plugin-rag": minor
---

A host chooses when knowledge extraction is reviewed: the memory and document engines' `review` option is a `KnowledgeReviewPolicy`, `"always"` (the default, as `true` was), `"off"` (as `false` was) or `"on-failure"`, which stages the unreviewed extraction and reviews each window's extraction only when staging refuses it as a whole with `Invalid` (a repeated entity key, no record that survives its checks, a document extraction that proposes personal memories). A record dropped on its own with a `RecordDropped` note starts no review; a review reply that does not decode fails with diagnostic stage `review`. `true` and `false` still decode from plugin options, but a typed `MemoryConfig` or `RagConfig` built in TypeScript (for `MemoryLive` or `RagLive`) now needs `"always"` or `"off"` instead of a boolean. `extractKnowledge` takes the policy and a `stage` function, and returns what `stage` returns. No prompt or output schema change, so the extraction version stays 8.
