---
"@xandreed/plugin-memory": minor
---

`MemoryCaptureAdmission` lets a host admit, replace the evidence of, or refuse each committed turn before conversation capture stores it; a refused turn enqueues nothing while the capture checkpoint still moves past it, and `MemorySyncResult.refused` reports it.
