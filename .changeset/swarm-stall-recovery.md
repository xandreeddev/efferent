---
"@xandreed/sdk-core": patch
"@xandreed/sdk-adapters": patch
"@xandreed/cli": patch
---

fix(swarm): a hung sub-agent no longer strands the fleet "checking for agents that never ran" — three layered recoveries + the degenerate-loop breaker that wasted the run.

A real `efferent code` run looked completely dead: the root spawned a sub-agent (`run_agent` → `{ status: "running" }`), then looped `wait_for_agents` forever while the node sat `running` with **zero** turns. Root cause was two compounding failures, both fixed:

- **The spawned sub-agent's first model call silently stalled** (a gateway connection that returns no bytes and no error). Nothing caught it: the exit finalizer only fires when the fiber EXITS (a parked fiber hasn't), and the mid-session sweeper only flips a node whose fiber is no longer on the bus (a parked fiber still is). So the node stranded `running` for up to ~20 min while the parent's `wait_for_agents` looped blind. Now a **stall watchdog** races every spawned run: no progress (no turn start, tool result, narration, or LLM retry) for `SUBAGENT_STALL_DEADLINE_MS` (180s) → interrupt → record a clear `STALL_NOTE` error → notify the parent, which unblocks. Retries count as progress, so a call weathering a transient overload is never killed; a tiny injected deadline unit-tests it without a real wait.
- **The per-request LLM timeout was 5 min** — far too long for a backgrounded run with nothing on screen. Cut to **2 min** (`LLM_REQUEST_TIMEOUT_MS`, all four custom adapters), below the watchdog deadline, so a stalled connect aborts → retries (visible) before the watchdog has to kill the run.
- **The root burned ~30 turns calling the same tool** (`list_scheduled_jobs`, identical args, identical empty result) before doing anything — saturating the gateway and wasting the run. A **degenerate-repeat circuit breaker** in the agent loop (mirroring the existing malformed-output breaker) detects an identical call+result signature repeating: it nudges once, then force-stops. Pollable tools (`wait_for_agents`, `bash_output`) and calls that return new info each time never trip it.

Guarded by deterministic tests that run in CI (`bun test`): the watchdog kills a hung sub-agent and records the stall (and does NOT kill a healthy one); the breaker stops a same-call/same-result spin (and does NOT stop a legitimate poll or a progressing loop); the request timeout is pinned at 2 min, below the watchdog deadline.
