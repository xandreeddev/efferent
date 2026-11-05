---
"@xandreed/plugin-memory": patch
"@xandreed/plugin-rag": patch
---

The memory and document workers scan for pending jobs untraced, so an idle worker records no spans; each job it claims is traced as before. Every scan (default every 2 s) used to export a root `knowledge_store.pending` trace, tens of thousands a day per process.
