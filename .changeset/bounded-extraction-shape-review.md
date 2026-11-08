---
"@xandreed/core": patch
"@xandreed/plugin-memory": patch
"@xandreed/plugin-rag": patch
---

Use one configured review per extraction window to repair malformed JSON or output shape, with bounded untrusted proposals and unchanged schema and source validation. Keep review off strict and version the shared extraction protocol and engine ids at 10; drain older queued jobs before upgrading.
