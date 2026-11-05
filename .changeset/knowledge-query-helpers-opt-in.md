---
"@xandreed/plugin-rag": minor
"@xandreed/plugin-memory": minor
---

`queryPlanning` and `rerank` default to `false` on the RAG and memory engines, so a search or recall makes no helper-model call unless the host opts in; set both to `true` to keep the previous query planning and evidence reranking, which behave as before when enabled.
