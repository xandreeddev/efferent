---
"@xandreed/sdk": minor
---

The kernel gains a media store: `MediaStore` (bytes kept under their SHA-256, `mediaHashOf`), its kit
`mediaStoreConformance`, `inMemoryMedia`, and on the Node entry `directoryMedia`, a folder written atomically and read
verified (ADR 0034).
