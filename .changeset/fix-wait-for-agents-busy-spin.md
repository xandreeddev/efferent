---
"@xandreed/sdk-core": patch
"efferent": patch
---

fix(fleet): a finished sibling no longer makes `wait_for_agents` busy-spin — and headless fleet completion stops false-tripping its deadline

The orchestrator "digging in a loop" had a concrete proximate cause in the bus. `wait_for_agents` (and the headless fleet-completion waiter) gather over "everything I spawned" via `childrenOf`, which returns running **and** finished children. `awaitChange` then decided whether to block by checking a **level** — `watch.some(status !== "running")` — which is permanently true once any child has finished. So once the first sub-agent completed, every later no-ids gather returned in ~1s instead of blocking, and a forced orchestrator "resolved" the early return by spawning **more** overlapping agents (a 9-agent fan-out for a 6-part task, never converging). The loop breaker couldn't catch it because the calls were structurally varied.

- **`awaitChange` now blocks on the transition, not the level.** It parks on the watched agents that are *still running* and wakes when one of *those* finishes (via the existing completion/wake deferreds) or when a message lands in the waiter's inbox — a finished child already arrives as inbox mail, so it's still harvested promptly, just no longer busy-returned. A no-ids gather with one sibling done and one running now blocks until real progress (proven deterministically; the old code returned in ~0 ms).
- **`childrenOf`'s contract is honest again, plus a `runningChildrenOf` for fleet-idle detection.** `childrenOf` keeps reporting running + finished children (the gather needs the finished ones' summaries), and its doc now says so. The "is the fleet still working?" consumers — headless `runFleetToCompletion`/`waitFleetIdle` and the fleet-scoped interrupt — switch to the new `runningChildrenOf` (running only). This fixes a real headless bug: `length === 0` never fired once a lead finished (finished children lingered in `childrenOf`), so `--mode json`/`-p` busy-looped to the 6-minute deadline and forced a degraded FINALIZE synthesis instead of a clean gather.

Guarded by tests in CI: the no-ids busy-spin regression (a finished sibling must NOT busy-return), a no-ids gather still waking the instant the last sibling finishes, and `runningChildrenOf` reaching length 0 when the fleet goes idle.
