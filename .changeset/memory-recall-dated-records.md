---
"@xandreed/core": minor
"@xandreed/plugin-memory": minor
---

Recalled memory shows the model when each record was said: `renderMemoryRecall` takes the recall's `sources` and labels a memory with its UTC date, kind and whether it was stated or inferred, a passage with its date, and a relation with its date and validity, under one reading rule; `now` adds today's date and marks ended relations. The `memory.recalled` section (version 2), `memoryRecallNote` and `recall_memory` render this way by default (`MemoryConfig.recallDates: true`); `recallToday` (default `false`) adds today's date. Without sources or with `dates: false` the text is unchanged. Core adds `knowledgeRecordDate`, the occurrence time of the revision a record's first span cites.
