---
"@xandreed/sdk-core": patch
---

distiller: route a user-stated **process** rule (a how-to-work lesson like "plan before a multi-step task") to `kind:"process"` instead of defaulting to `constraint`.

The miner prompt's Rule 5 hardcoded every user correction as a `constraint`, so a working-method rule the human stated was mis-filed (it belongs in the operating-guidance overlay, not `CONSTRAINTS.md`). The prompt now classifies kind by **subject** — a code/domain rule → `constraint`, a working-method rule (plan, verify, sequence, delegate) → `process` — even when a user states it.

Measured on the fast tier (`deepseek-v4-flash`, 5 samples/case): user-stated process-routing accuracy **0.20 → 1.00**, with constraint routing unchanged (no domain rule leaks into `process`).
