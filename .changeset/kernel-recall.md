---
"@xandreed/sdk": minor
---

The kernel recalls by meaning: `withRecall({ limit, pool?, reorder? })` sends the links and facts nearest a question
over the host's `Embedder` and `VectorStore`, as a note of its own (`recallNote`), and says what it found live
(`plugin.recall.recalled`). Each fact's day is `learnedOf` (ADR 0021, amended).
