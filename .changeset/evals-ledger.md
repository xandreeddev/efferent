---
"@xandreed/evals": minor
"@xandreed/evals-cli": minor
---

`@xandreed/evals` and `@xandreed/evals-cli` take the run's spend ledger
  from the kernel. It keeps its key, `@xandreed/core/ModelSpend`, with a
  narrower contract: no `forget`, `totals` with no argument, and a
  `SpendRequest` of an amount and a total cap, with no `runId` and no
  per-turn cap. A runnable that reserves imports `ModelSpend` from
  `@xandreed/core` and names neither. The kernel's providers charge the
  ledger they are given, so an eval run's budget caps what they send.
