---
"@xandreed/plugin-memory-window": minor
---

A request over its budget shows earlier turns' results through their tools' compact views before the window spills a result or drops a turn, also with `compactPreviousTurn: false`, which now means never at a turn's start: the fewest results that fit, the one that frees the most first, and only when the compact view is shorter than what the result shows. Requests that fit their budget are unchanged. The order under pressure is compact, spill, drop; with `currentTurnFirst`, compact, drop, spill.
