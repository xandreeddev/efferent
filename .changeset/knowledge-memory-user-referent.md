---
"@xandreed/core": minor
"@xandreed/plugin-memory": minor
"@xandreed/plugin-rag": minor
---

Memory extraction now says how to refer to the conversation's user. Extraction models commonly named an undefined `user` key in a memory's entities or as a relation's subject, and staging dropped each such record with a `RecordDropped` note, losing the memory. In memory mode, `knowledgeExtractionPrompt` adds one rule: memories are already about the conversation's user, so a memory never lists the user in its entities; a relation whose subject or object is the user defines the user as an entity like any other; and every key a record names is defined in entities. The shared output schema describes a memory's `entities` and a relation's `subject` and entity object `key` as keys defined in entities. The document prompt is otherwise unchanged and staging is unchanged. Extraction version 8 moves the engine ids to `memory:8/…` and `rag:8/…`; `retry` requeues a failed version 7 job under the new id through `KnowledgeIndex.requeue`.
