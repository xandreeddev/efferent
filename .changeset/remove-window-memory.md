---
"@xandreed/sdk": minor
---

The window memory is removed (ADR 0037): `windowMemory`, `WindowOptions`, `windowDroppedEvent`, `windowPressureEvent` and their data are gone, since a memory that drops one more turn for every new message misses a provider's prompt cache on every message. Use `summaryMemory` over a `Summarizer` for a conversation kept to a budget, or `flatMemory` for the whole of it; a journal holding the window's `plugin.window.dropped` records opens as it is, and the turns it had dropped are sent again. New: `flatMemoryWith({ pointers })`, the flat memory with long tool results sent as pointers.
