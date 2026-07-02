---
"@xandreed/sdk-core": minor
"@xandreed/sdk-adapters": minor
"efferent": minor
---

The one gate: persisted, bounded, honest — and the learning loop's counters finally move.

Every gate round now lands in a `gate_verdicts` audit table (sqlite 0011 / pg 0015) — verdict, reasons, files, advisory flag, duration, and, for `unavailable`, the verifier's error text. The forensic "claude exited 1 after 2s ×3 → silent bypass" class is traceable after the fact, and `ConversationStore.listGateVerdicts` answers "was this actually verified?".

The gate is bounded now: the verifier subprocess default drops 30 → 10 minutes, `maxLoopAttempts` defaults to 2 (one retry — each retry re-runs the whole fleet), and a 15-minute wall clock caps the whole gate phase (persisting a budget-exhausted row instead of spinning). The settle-before-judging wait flips the other way: the old ~30s ceiling judged still-RUNNING fleets mid-flight (and the retry then spawned a duplicate fleet beside the live one); with every run now guaranteed to reach a terminal status, settle waits properly (5s polls, a ~10-min never-hit backstop).

Scheduled (cron) runs stop being gate-free: `submitJob`'s scheduled path runs a one-shot gate over the spawned deliverable, persists the verdict, and folds a `needs_work`/`blocked` into a `partial` outcome — no retry loop (nobody is watching to steer one), but never silent.

Reinforcement is wired: re-learning an existing constraint bumps its ✓ (the miner + gate re-surfacing it IS the signal it keeps mattering), and the gate prompt now lists the loaded CONSTRAINTS.md ids so a violated one is cited by id in the verdict (`constraintsViolated`) and gets its ✗ bumped. Before this every persisted constraint sat at `(✓0 ✗0)` forever — the "self-improving" loop had never once reinforced a lesson.
