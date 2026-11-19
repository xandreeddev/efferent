---
"@xandreed/sdk": minor
---

The kernel curates a turn and recalls what is kept (ADR 0023): `curate` and `curateAgain`, the curation step a host's
program calls after a turn, with `knowledgeSession`, `knowledgeJournal` and `keptFrom`; and `withKnowledge`, a memory
wrapper that sends each request what is kept about what the conversation names, with no model and no embedder
(`recallKnowledge`, `knowledgeNote`, `plugin.knowledge.recalled`).
