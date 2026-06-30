---
"@xandreed/sdk-core": patch
"efferent": patch
---

fix(prompts): orchestrator fan-out discipline — decompose once, gather by looping, never re-spawn on an early wait

The live failure spawned **9 overlapping leads** for one 6-part mission (deep-dive → "produce report" → 3× investigate → quick-read → 3× read of the same files) and kept adding more whenever a gather came back with agents still running. The proximate cause (a busy-returning `wait_for_agents`) is fixed separately; this hardens the orchestrator prompt so the behaviour can't recur on a weak model.

- **Decompose ONCE, don't pre-split.** A broad job goes to ONE lead — the coordinator / research-coordinator decompose and fan out their own workers — instead of the root spawning several leads for the same objective. Split across leads only when the request has genuinely separate parts, and spawn that set in a single turn.
- **Gather by looping `wait_for_agents`; NEVER re-spawn to "unstick" a lead.** A return with `allDone: false` and leads still running is NORMAL — call it again; it is not a signal that anything is stuck or that more agents are needed. Re-delegating / status-messaging / spawning on an early return is the exact failure mode that floods the fleet.
- **Harvest with `wait_for_agents`, not `send_message`.** A finished lead is gone from the bus; `send_message` only steers a still-running one (the live run hit `AgentNotRunning` trying to message a finished agent).

Carried in both the orchestrator role prompt (`renderOrchestrateRole`) and the `wait_for_agents` tool description, so the rule reaches the model from both the system prompt and the tool schema. Guarded by a coder-prompt test.
