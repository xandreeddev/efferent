---
"@xandreed/sdk-core": patch
"efferent": patch
---

fix(root): the orchestrator root finally matches its toolkit — a dedicated delegate-first prompt, trimmed tools, and a loop breaker that catches the real spin.

When a fleet lead is in the roster (the normal CLI), the root is a pure orchestrator with **no work tools** (#83 strips read/grep/edit/Bash as a mechanical guarantee that it delegates). But the prompt was never switched to match: it still advertised `read_file`/`grep`/`edit_file`, told the root to "read the workspace" and "Read the blackboard FIRST", then said "orchestrate, don't do the work". A weak model couldn't reconcile the contradiction, so on "investigate the codebase" it looped on the only tools it could execute — `list_scheduled_jobs`, `blackboard_read`, `update_plan` — and never delegated.

- **Prompt ↔ toolkit alignment (the core fix).** `coderSystemPrompt` now branches on the SAME condition as the toolkit (`isOrchestrateMode`, a new shared helper used by both `coder.ts` and `buildScopeRuntime.ts`, so they can't drift). In orchestrate mode the root gets a lean `orchestratorSystemPrompt` that lists ONLY the tools it has and makes "delegate first" unmistakable — no work-tool advertising, no "read the blackboard FIRST". With no fleet present it falls back to the unchanged hands-on `directCoderSystemPrompt`.
- **Trimmed the root's tools to four** — `run_agent`, `wait_for_agents`, `send_message`, `update_plan`. The scheduling tools (`schedule`/`list_scheduled_jobs`/`cancel_scheduled_job`) and blackboard tools (`blackboard_post`/`blackboard_read`) — the exact ones the model fixated on — are removed from the root (still available to sub-agents/the daemon).
- **The loop breaker now catches the real spin.** It was defeated by `update_plan` (whose args change every turn). The signature is now keyed on RESULTS (not args) and counted as no-progress-over-the-run (a novel result resets the counter), so an interleaved `[list+blackboard] ↔ update_plan` spin trips once each signature has been seen.
- **Evals fixed.** Three suites (`swarm`, `researchEfficiency`, `delegationDecision`) now opt into the fleet (`includeFleet: true`) — without it the lead is `UnknownAgent` and they scored 0. `delegationDecision` is reconciled to the orchestrator reality (coding → coordinator, investigation → research-coordinator, pure interaction → direct). And the `orchestratorPurityScore` "root didn't code" check — vacuously 1.0 now that the root *can't* code — additionally requires a real delegation, so a root that loops on housekeeping scores 0.

Guarded by tests that run in CI: the orchestrate prompt is asserted to list only the four tools and contain no work-tool / blackboard language; the breaker catches the interleaved spin; the purity scorer fails a no-delegation loop.
