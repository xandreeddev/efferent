---
"@xandreed/sdk": minor
---

The kernel no longer holds the graph contract and its plugin (`withGraph`, `linkThings`, `unlinkThings`,
`followThings`, the graph session and its records) or recall by meaning over facts and links (`withRecall`,
`recallNote`, `plugin.recall.recalled`), nor the facts' `learnedOf`, which only recall read. Memory kept by a curator
and recalled from what the conversation names replaces both (`curate`, `withKnowledge`, ADRs 0022 and 0023). The
`Embedder` and `VectorStore` contracts and their stock plugins stay. The knowledge contract's `folded` is exported.
