---
"@xandreed/sdk-core": minor
"efferent": minor
---

Make the root a pure orchestrator: it routes all real work to a coordinator / research-coordinator and does no coding/research itself.

- The root prompt is rewritten to "always orchestrate" (route code → coordinator, investigation → research-coordinator; only pure conversation stays direct).
- Mechanical guarantees (a prompt rule alone didn't hold): when a fleet lead is in the roster the root gets an **orchestration-only toolkit** (no read/edit/write/grep/Bash/search tools), and its `run_agent` is **hard-railed** so it can only delegate to a coordinator/research-coordinator (no bare-worker spawn), with a runtime backstop.
- New `orchestration` eval + `orchestratorPurityScore` assert the root delegates through a lead and keeps its hands off the work (the harness now captures root-only `rootTools` / `rootSpawnedAgents`).
