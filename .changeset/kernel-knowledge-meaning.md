---
"@xandreed/sdk": minor
---

What is kept can also be found by meaning (ADR 0025): `withKnowledgeByMeaning`, a memory wrapper that adds a third list
to `withKnowledge`'s two, the memories nearest the last message by an `Embedder` over a `VectorStore` (an index of the
journal keyed by `meaningKey`), fused by rank with weights 1, 0.5 and 1.5 (`pool`, `weights`, an optional `floor`); an embedder that fails skips the
list by meaning for that request; `recallKnowledge` takes
what the store found (`ByMeaning`), and `plugin.knowledge.recalled` says each memory's place and cosine by meaning.
