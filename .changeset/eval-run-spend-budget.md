---
"@xandreed/evals": minor
"@xandreed/evals-cli": minor
---

An evaluation run's spend budget: `--budget-usd` on `run` and `calibrate` (`EvaluationSelection.spendBudget`) caps every model send of every trial in one shared `ModelSpend` ledger, stops starting trials once the budget refuses a send or is reached (the rest `skipped`, never failures), and records each trial's and the run's settled spend in the report (`Trial.spend`, `EvaluationRun.spend`).
