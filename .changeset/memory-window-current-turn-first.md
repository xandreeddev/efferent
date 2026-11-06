---
"@xandreed/plugin-memory-window": minor
---

Window memory's `currentTurnFirst` option keeps the current turn's tool results whole under budget pressure: earlier turns are compacted and dropped first, and the current turn's results are spilled only when the current turn alone does not fit. The strategy keeps its id and records the order in its version (`2+current-turn-first`); the default order is unchanged.
