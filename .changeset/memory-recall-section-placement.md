---
"@xandreed/plugin-memory": minor
---

`recallSection: "off"` turns off the memory engine's `memory.recalled` turn section and its capture catch-up, and `memoryRecallNote(config)` gives that section's text for a host to place in its step context (a turn policy's `step` with `stepContext: "tail"`, or a `ModelRequestHook`). The default (`"turn"`) is unchanged.
