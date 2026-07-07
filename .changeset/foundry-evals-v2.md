---
"@xandreed/evals": minor
---

Evals v2 contract: `EvalSpec.scorers` is non-empty by type (`scorers: []` no
longer typechecks — the silent-0 hole is unrepresentable) and `threshold` is
required and honored per-suite by the run gate (the hardcoded 0.6 bar is
gone). Enforced statically by the new foundry `eval-shape` gate (non-empty
scorers, explicit threshold, registration in `run.ts`).
