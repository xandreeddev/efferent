---
"@xandreed/core": minor
"@xandreed/plugin-memory": patch
"@xandreed/plugin-rag": patch
"@xandreed/plugin-models": patch
"@xandreed/plugin-knowledge-postgres": patch
---

A failed knowledge extraction records where and how it failed on its job, without its content: `KnowledgeJobFailure` and `KnowledgeError` gain an optional `diagnostic` (`KnowledgeFailureDiagnostic`) with the stage (`extract`, `review` or `stage`), the path of the first decode issue, the finish reason and output tokens the helper completion reported, and the source window the call read, so a reply cut off at the output cap reads `finishReason: "length"` apart from a schema drift or a staging refusal. `UtilityCompletion` gains an optional `finishReason`, filled by the models plugin's `UtilityLlmLive`. `extractKnowledge`'s `complete` now returns the helper's `UtilityCompletion`, which it decodes. The memory and document engines record the diagnostic (`knowledgeJobFailure`) and set it on the processing span (`knowledgeFailureAttributes`); the in-memory and PostgreSQL stores keep it in the job payload and list it, and older failures decode without one. No prompt change, so the extraction version stays 8.
