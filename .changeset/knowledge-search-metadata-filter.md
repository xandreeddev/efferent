---
"@xandreed/core": minor
"@xandreed/plugin-rag": minor
"@xandreed/plugin-memory": minor
"@xandreed/plugin-knowledge-postgres": minor
---

Knowledge search, recall and a turn's reach take an optional `metadata` filter on the cited source revisions' metadata, applied by every store before its nearest-neighbour limit and honoured by both engines and the document and memory capabilities. While a reach has a metadata filter, `forget_memory` answers every source as not found, since forgetting removes every revision and the filter judges revisions.
