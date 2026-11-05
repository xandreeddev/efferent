---
"@xandreed/core": minor
---

Decode stored tool lifecycle and conversation message records with typed schemas: `StoredData` adds `tool.started`, `tool.completed`, `tool.refused` and `memory.message` (`ToolStartedData`, `ToolCompletedData`, `ToolRefusedData`, `MemoryMessageData`), so `readStored` types them, and `decodeStored(kind, event)` and `storedRecordOf(event)` decode one record at a time.
