---
"@xandreed/core": patch
"@xandreed/plugin-memory-window": patch
---

`recall_context`, its paging and the spill preview live in `@xandreed/core` (`recallCapabilityOf`, `spillPreview`, `RECALL_TOOL`); the window plugin's `recallCapability` and every text the model reads are unchanged.
