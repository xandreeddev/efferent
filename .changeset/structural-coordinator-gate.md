---
"@xandreed/sdk-core": minor
"efferent": minor
---

Make the gate structural at both tiers, remove the gate tools, and add a Claude-style fleet UX.

- **Coordinator-tier gate is now structural.** Each lead (coordinator / research-coordinator) validates its own subtree through the same independent Opus gate the root uses — extracted into one shared `gateOnce` helper (`core/usecases/gateLoop.ts`) used by both `driveLoop` (root aggregate pass) and `runSpawnedAgent` (per-lead, before it returns). On `needs_work` it distills + re-runs the lead's loop with the gate's reasons, to `maxLoopAttempts`. Gating no longer depends on the model remembering to call a tool.
- **Gate tools removed.** Because gating/distilling/retrying is fully structural, `verify_with_gate` and `note_constraint` are gone from the root's orchestration toolkit and the coordinator/research-coordinator toolsets (defs + handlers deleted). The coordinator prompts drop the manual `GATE → LEARN → RETRY` phase; `autoLoop` only shapes whether DELIVER is gate-aware. The architect role stays as the in-fleet, fine-grained per-piece review.
- **Claude-style fleet UX.** The running loader now shows `waiting for N agents` once the root's turn ends but background agents run on (not a dead idle screen), and each top-level lead gets one clean `✓ name — summary` / `✗ …` completion line on the root rail when it finishes. Sub-agent tool calls still never leak to the main rail (they route to the fleet tree / node log).
