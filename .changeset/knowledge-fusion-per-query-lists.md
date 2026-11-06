---
"@xandreed/core": patch
"@xandreed/plugin-memory": patch
"@xandreed/plugin-rag": patch
---

With query planning on, memory recall and document search rank each planned query's lexical and semantic lists on their own: a candidate scores `1 / (61 + rank)` in every list that holds it, summed, so one only a planned query finds is no longer ranked after all of the question's candidates. `fuseKnowledgeCandidates` takes one `KnowledgeCandidates` pair or one per query; a single pair fuses exactly as before.
