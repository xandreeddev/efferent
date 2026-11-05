---
"@xandreed/core": minor
"@xandreed/plugin-models": minor
"@xandreed/sdk": minor
---

Model spend caps: core's `ModelSpend` ledger port (`ModelSpendMemoryLive`, `modelSpendConformance`; the turn forgets itself in the ledger as it ends), the models plugin's `spend` option that reserves each physical send's worst case and settles it at the cost of its reported usage within a per-turn and a total cap (`model.spend`, `model.unpriced`), `TurnResult.spend` and `CurrentTurnRunId`.
