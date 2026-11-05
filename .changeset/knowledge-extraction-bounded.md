---
"@xandreed/core": minor
"@xandreed/plugin-rag": minor
"@xandreed/plugin-memory": minor
---

Knowledge extraction is bounded per call: the memory and document engines take `maxExtractionChars` (48,000 by default) and extract a longer source window by window through core's `extractKnowledge`, merging the windows' results with exact whole-source offsets before staging. Every helper call the engines make runs with `CurrentKnowledgeHelperCall` set to its purpose (`extract`, `review`, `plan`, `rerank`), scope, job and attempt, and the optional, advisory `maxHelperOutputTokens` (applied only by a `UtilityLlm` that reads it, which the models plugin's does not), so a `UtilityLlm` adapter can budget or refuse it.
