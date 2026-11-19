---
"@xandreed/evals": minor
---

`@xandreed/evals`: `runEvaluation` grades each trial as it ends, in place
  of every trial once all have run, so a run cut short keeps the grades of
  the trials it finished. A run's `eval.grade` spans are under `eval.run`.
